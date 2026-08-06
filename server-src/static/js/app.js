// ===== 传送 =====

const VERSION = '2.1.0';

const App = {
    ws: null,
    deviceId: null,
    deviceName: '',
    devices: new Map(),
    mode: 'send',
    selectedTarget: null,
    selectedFiles: [],
    receiveHistory: [],
    pendingReceive: null,
    activeUpload: false,
    userTheme: 'light',
    heartbeatTimer: null,
    reconnectTimer: null,
    _acceptHandlers: new Map(),
    _rejectHandlers: new Map(),
    _acceptWaiters: new Map(), // taskId -> waitForAccept 的 resolve（本端取消时立即结束等待）
    _idb: null,
    _dbReady: null,
    _iceServers: null,
    _maxFileSizeMB: 50,   // 默认 50MB，由 /api/max-file-size 动态更新
    _room: null,       // { id, code, ownerId, devices: Map }
    _roomDevices: new Map(),  // 房间内设备（跨网络互传）
    _deviceView: 'lan',  // 设备列表视图：'lan' 局域网 | 'room' 房间
    _isPublicMode: false, // 公网受限模式：经反代访问且非局域网 IP 时为 true
    _renderTimer: null,   // renderDevices 防抖定时器
    _modeDetermined: false, // 网络模式是否已在 welcome 后确定（防止后续 report_lan 误翻转）
    _wakeLock: null,       // Screen Wake Lock 屏幕常亮
    _hintedLanRoom: new Set(), // 房间成员被同网络发现的提示去重（服务器会在设备上线/report_lan/reEvaluate 等时机多次推送 device_list）

    $: (id) => document.getElementById(id),

    init() {
        this.userTheme = localStorage.getItem('yuanbaba_theme') || 'auto';
        this.deviceName = localStorage.getItem('yuanbaba_name') || '';
        this.mode = localStorage.getItem('yuanbaba_mode') || 'send';
        this._everConnected = false;  // 用于判断是否局域网被拒
        // 微信浏览器检测：显示顶部提醒，但不禁用接收功能
        this.isWechat = /micromessenger/i.test(navigator.userAgent);
        this.applyTheme();
        this.bindEvents();
        this.connect();
        this.loadHistory();
        // 进入页面即触发网络能力探测（此前仅在发起传输时才间接触发，导致一直显示"正在检测"）
        this.fetchIceServers().catch(() => {});
        // 获取最大文件大小限制
        this.fetchMaxFileSize().catch(() => {});
        // 恢复上次的 tab
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === this.mode));
        this.$('sendPanel').classList.toggle('hidden', this.mode !== 'send');
        this.$('recvPanel').classList.toggle('hidden', this.mode !== 'recv');
        this.updateRecvNotice();
        // 监听系统主题变化（auto 模式下实时切换）
        if (window.matchMedia) {
            const mql = window.matchMedia('(prefers-color-scheme: dark)');
            mql.addEventListener('change', () => { if (this.userTheme === 'auto') this.applyTheme(); });
        }
        // 屏幕常亮：页面恢复可见后，若传输仍在进行，重新请求 Wake Lock
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && (this.activeUpload || this._recvPC)) {
                this.requestWakeLock();
            }
        });
        // 生成初始二维码（页面 URL）
        this.updateQRCode();
        // tabs 动态对齐 main 容器中心（CSS 计算不可靠）
        this._syncTabsCenter();
        window.addEventListener('resize', () => this._syncTabsCenter());
    },

    // 同步 header-tabs 位置对齐 main 容器水平中心
    _syncTabsCenter() {
        const tabs = document.querySelector('.header-tabs');
        const main = document.querySelector('.main');
        if (tabs && main) {
            const r = main.getBoundingClientRect();
            tabs.style.left = (r.left + r.width / 2) + 'px';
        }
    },

    // ===== IndexedDB 持久化（流式分片存储，避免大文件内存溢出）=====
    initDB() {
        if (this._dbReady) return this._dbReady;
        this._dbReady = new Promise((resolve, reject) => {
            const req = indexedDB.open('yuanbaba-transfer', 2);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('files')) {
                    db.createObjectStore('files', { keyPath: 'taskId' });
                }
                if (!db.objectStoreNames.contains('chunks')) {
                    const store = db.createObjectStore('chunks', { keyPath: 'key' });
                    store.createIndex('taskId', 'taskId', { unique: false });
                }
            };
            req.onsuccess = (e) => { this._idb = e.target.result; resolve(); };
            req.onerror = (e) => reject(e.target.error);
        });
        return this._dbReady;
    },

    async fetchIceServers() {
        if (this._iceServers) return this._iceServers;
        const tryUrls = ['api/ice-servers', '/api/ice-servers'];
        let data = null;
        for (const u of tryUrls) {
            try {
                const res = await fetch(u);
                if (res.ok) { data = await res.json(); break; }
            } catch { /* 尝试下一个候选路径 */ }
        }
        this._iceServers = (data && data.iceServers) || [{ urls: 'stun:stun.l.google.com:19302' }];
        // 仅 STUN 列表（直连优先用）：剔除 TURN/TURNS 中继，强制走 host/srflx 打洞
        const direct = this._iceServers.filter(s => {
            const urls = Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls || '');
            return !/turn:/i.test(urls);
        });
        this._iceServersDirect = direct.length ? direct : this._iceServers;
        // 拿到 ICE 配置后，主动补一次网络能力预判（首屏可能早于接口返回）
        this.probeNetworkCapability();
        return this._iceServers;
    },

    // 传输用 ICE 服务器决策：本机探测到 srflx（NAT 反射/可打洞）时优先直连（仅 STUN，
    // 不含 TURN），避免明明能 NAT 穿透却误走 TURN 中继；否则/降级重试时用完整列表（TURN 兜底）。
    // isSender=true 时支持 _forceTurn 强制走完整列表（直连失败后的 TURN 降级重试）。
    async _getIceServersForConnection(isSender) {
        const full = await this.fetchIceServers();
        if (!isSender) {
            // 接收端：必须始终包含 TURN。TURN 中继要求双方都向服务器分配 relay 候选，
            // 接收端若剔除 TURN，发送端直连失败后降级中继将永远建立不起来。
            // 直连优先不受影响：ICE 按候选优先级选 pair（host > srflx/prflx > relay），
            // 带上 TURN 只是多一个兜底候选，不会抢在直连前面。
            this._lastConnectUsedFull = true;
            return { servers: full, useFull: true };
        }
        let useFull = this._natHasStunPublic !== true; // 探测未完成或本机无打洞能力 → TURN 兜底
        if (this._forceTurn) {
            useFull = true;
            this._forceTurn = false;
        }
        this._lastConnectUsedFull = useFull;
        if (useFull) return { servers: full, useFull: true };
        const direct = (this._iceServersDirect && this._iceServersDirect.length) ? this._iceServersDirect : full;
        return { servers: direct, useFull: false };
    },

    async fetchMaxFileSize() {
        const tryUrls = ['api/max-file-size', '/api/max-file-size'];
        for (const u of tryUrls) {
            try {
                const res = await fetch(u);
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.max_file_size_mb > 0) {
                        this._maxFileSizeMB = data.max_file_size_mb;
                        // 更新页面显示
                        const el = document.getElementById('maxSizeDisplay');
                        if (el) el.textContent = data.max_file_size_mb;
                        return;
                    }
                }
            } catch { /* 尝试下一个候选路径 */ }
        }
    },

    async dbPut(record) {
        try {
            await this.initDB();
            return new Promise((resolve, reject) => {
                const tx = this._idb.transaction('files', 'readwrite');
                tx.objectStore('files').put(record);
                tx.oncomplete = () => { console.log('[IndexedDB] 元数据写入成功:', record.taskId); resolve(); };
                tx.onerror = () => { console.error('[IndexedDB] 元数据写入失败:', tx.error); reject(tx.error); };
            });
        } catch (e) { console.error('IndexedDB put 失败:', e); }
    },

    async dbGet(taskId) {
        try {
            await this.initDB();
            return new Promise((resolve, reject) => {
                const tx = this._idb.transaction('files', 'readonly');
                const req = tx.objectStore('files').get(taskId);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } catch (e) { console.error('IndexedDB get 失败:', e); return null; }
    },

    // 格式化 IP 地址：IPv6 显示为空，内网 IPv4 正常显示
    formatIP(ip) {
        if (!ip) return '';
        if (/^(127\.|^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.)/.test(ip)) return ip;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
        return '';
    },

    // 设备卡片展示 IP：优先显示前端探测到的私网 IP（同局域网用户可直观确认网段）
    deviceDisplayIP(d) {
        if (d.localLanIp && d.localLanIp !== d.ip) return d.localLanIp;
        return this.formatIP(d.ip);
    },

    async dbAll() {
        try {
            await this.initDB();
            return new Promise((resolve, reject) => {
                const tx = this._idb.transaction('files', 'readonly');
                const req = tx.objectStore('files').getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
        } catch (e) { console.error('IndexedDB all 失败:', e); return []; }
    },

    // 分片写入
    async dbPutChunk(taskId, index, blob) {
        try {
            await this.initDB();
            return new Promise((resolve, reject) => {
                const tx = this._idb.transaction('chunks', 'readwrite');
                tx.objectStore('chunks').put({
                    key: taskId + '-' + index,
                    taskId: taskId,
                    index: index,
                    blob: blob
                });
                tx.oncomplete = () => { console.log('[IndexedDB] 分片写入成功:', taskId, 'index:', index, 'size:', blob.size); resolve(); };
                tx.onerror = () => { console.error('[IndexedDB] 分片写入失败:', tx.error); reject(tx.error); };
            });
        } catch (e) { console.error('IndexedDB putChunk 失败:', e); }
    },

    // 读取所有分片（按 index 排序）
    async dbGetChunks(taskId) {
        try {
            await this.initDB();
            return new Promise((resolve, reject) => {
                const tx = this._idb.transaction('chunks', 'readonly');
                const index = tx.objectStore('chunks').index('taskId');
                const req = index.getAll(taskId);
                req.onsuccess = () => {
                    const results = req.result || [];
                    results.sort((a, b) => a.index - b.index);
                    resolve(results.map(r => r.blob));
                };
                req.onerror = () => reject(req.error);
            });
        } catch (e) { console.error('IndexedDB getChunks 失败:', e); return []; }
    },

    async dbClear() {
        try {
            await this.initDB();
            return new Promise((resolve, reject) => {
                const tx = this._idb.transaction(['files', 'chunks'], 'readwrite');
                tx.objectStore('files').clear();
                tx.objectStore('chunks').clear();
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) { console.error('IndexedDB clear 失败:', e); }
    },

    // 从 IndexedDB 加载历史记录
    async loadHistory() {
        try {
            const records = await this.dbAll();
            console.log('[历史恢复] 读取到', records.length, '条记录:', records);
            this.receiveHistory = records.map(r => ({
                taskId: r.taskId,
                fileName: r.fileName,
                fileSize: r.fileSize,
                fromName: r.fromName,
                time: new Date(r.time),
                status: 'saved',
                mime: r.mime,
                blobUrl: null,
                savedToDisk: r.savedToDisk || false,
                chunkCount: r.chunkCount || 0
            })).sort((a, b) => new Date(b.time) - new Date(a.time));
            console.log('[历史恢复] 恢复后 receiveHistory:', this.receiveHistory);
            this.renderReceiveList();
        } catch (e) {
            console.error('[历史恢复] 加载失败:', e);
            this.renderReceiveList();
        }
    },

    // ===== 主题 =====
    applyTheme() {
        // auto 模式：跟随系统（Windows/iOS/Android 均支持 prefers-color-scheme）
        let actual = this.userTheme;
        if (actual === 'auto') {
            actual = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
        }
        document.documentElement.setAttribute('data-theme', actual);
        // 同步 theme-color meta（影响浏览器地址栏/状态栏颜色）
        const themeColor = actual === 'dark' ? '#1e2024' : '#f5f6f8';
        document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', themeColor));
        document.querySelectorAll('.theme-opt').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === this.userTheme);
        });
    },
    setTheme(theme) {
        this.userTheme = theme;
        localStorage.setItem('yuanbaba_theme', theme);
        this.applyTheme();
    },

    // ===== 事件绑定 =====
    bindEvents() {
        // 模式切换
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchMode(tab.dataset.mode));
        });

        // 设置
        this.$('settingsBtn').addEventListener('click', () => this.openSettings());
        this.$('closeSettings').addEventListener('click', () => this.closeSettings());
        this.$('settingsOverlay').addEventListener('click', (e) => {
            if (e.target === this.$('settingsOverlay')) this.closeSettings();
        });
        this.$('nameInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { this.saveName(e.target.value.trim()); this.closeSettings(); }
        });
        // 主题选项：仅绑定带 data-theme 的按钮（"关于"按钮无 data-theme，单独处理）
        document.querySelectorAll('.theme-opt').forEach(btn => {
            if (btn.dataset.theme) btn.addEventListener('click', () => this.setTheme(btn.dataset.theme));
        });
        // 关于入口：从主题切换区"关于"按钮打开（保留在设置弹窗内，体验更顺）
        this.$('aboutFromTheme').addEventListener('click', () => { this.closeSettings(); this.openAbout(); });

        // 关于弹窗
        this.$('closeAbout').addEventListener('click', () => this.closeAbout());
        this.$('aboutOverlay').addEventListener('click', (e) => {
            if (e.target === this.$('aboutOverlay')) this.closeAbout();
        });

        // 文件上传
        const dz = this.$('dropzone');
        const fi = this.$('fileInput');
        dz.addEventListener('click', () => fi.click());
        fi.addEventListener('change', (e) => { this.addFiles(Array.from(e.target.files)); fi.value = ''; });
        dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
        dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
        dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('dragover'); this.addFiles(Array.from(e.dataTransfer.files)); });

        // 发送
        this.$('sendBtn').addEventListener('click', () => this.startSend());
        this.$('clearBtn').addEventListener('click', () => this.clearFiles());
        this.$('clearHistoryBtn').addEventListener('click', () => this.clearHistory());

        // 刷新设备列表
        this.$('refreshDevices').addEventListener('click', () => this.refreshDevices());

        // 接收弹窗
        this.$('recvAccept').addEventListener('click', () => this.acceptReceive());
        this.$('recvReject').addEventListener('click', () => this.rejectReceive());
        this.$('receiveOverlay').addEventListener('click', (e) => {
            if (e.target === this.$('receiveOverlay')) this.rejectReceive();
        });

        // 进度弹窗
        this.$('progressDone').addEventListener('click', () => this.closeProgress());
        this.$('progressCancel').addEventListener('click', () => this.cancelTransfer());

        // 预览弹窗
        this.$('previewClose').addEventListener('click', () => this.closePreview());
        this.$('previewOverlay').addEventListener('click', (e) => {
            if (e.target === this.$('previewOverlay')) this.closePreview();
        });
        this.$('previewSave').addEventListener('click', () => this.saveMedia());

        // 微信提示：复制链接到系统浏览器打开
        this.$('wechatCopyBtn').addEventListener('click', () => this.copyLink());

        // 复制页面链接分享
        const copyBtn = this.$('copyUrlBtn');
        if (copyBtn) copyBtn.addEventListener('click', () => this.copyShareUrl());

        // 跨网络互传折叠面板
        this.$('roomToggle').addEventListener('click', () => this.toggleRoomCollapse());
        this.$('clearDataBtn').addEventListener('click', () => this.clearLocalData());
        this.$('roomCreateBtn').addEventListener('click', () => this.createRoom());
        this.$('roomJoinBtn').addEventListener('click', () => this.joinRoom());
        this.$('roomLeaveBtn').addEventListener('click', () => this.leaveRoom());
        this.$('roomCodeCopy').addEventListener('click', () => this.copyRoomCode());
        // 设备列表视图切换（局域网 / 房间）
        this.$('deviceTabLan').addEventListener('click', () => this.setDeviceView('lan'));
        this.$('deviceTabRoom').addEventListener('click', () => this.setDeviceView('room'));

        // 文件大小超限浮窗
        this.$('sizeLimitOk').addEventListener('click', () => {
            this.$('sizeLimitOverlay').classList.add('hidden');
        });
        this.$('sizeLimitOverlay').addEventListener('click', (e) => {
            if (e.target === this.$('sizeLimitOverlay')) this.$('sizeLimitOverlay').classList.add('hidden');
        });
    },

    // ===== 模式切换 =====
    switchMode(mode) {
        if (this.mode === mode) return;
        this.mode = mode;
        localStorage.setItem('yuanbaba_mode', mode);
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
        this.$('sendPanel').classList.toggle('hidden', mode !== 'send');
        this.$('recvPanel').classList.toggle('hidden', mode !== 'recv');
        this.updateRecvNotice();
    },

    // 微信浏览器在接收 tab 显示顶部提醒，但不隐藏接收功能
    updateRecvNotice() {
        const notice = this.$('wechatNotice');
        if (!notice) return;
        const showNotice = this.isWechat && this.mode === 'recv';
        notice.classList.toggle('hidden', !showNotice);
        // 不再隐藏 recvHero 和 section，接收功能完整可用
    },

    // ===== 跨网络互传 =====
    toggleRoomCollapse() {
        const head = this.$('roomToggle');
        const body = this.$('roomBody');
        const isHidden = body.classList.contains('hidden');
        if (isHidden) {
            body.classList.remove('hidden');
            head.classList.add('expanded');
        } else {
            body.classList.add('hidden');
            head.classList.remove('expanded');
        }
    },

    // 展开跨网络互传折叠面板（创建/加入/收到房间信息后调用，确保暗号可见）
    expandRoomCollapse() {
        const head = this.$('roomToggle');
        const body = this.$('roomBody');
        body.classList.remove('hidden');
        head.classList.add('expanded');
    },

    renderRoomState() {
        const idle = this.$('roomIdle');
        const active = this.$('roomActive');
        if (this._room) {
            idle.classList.add('hidden');
            active.classList.remove('hidden');
            // 进入房间后自动展开折叠面板，确保用户能看到房间号
            this.expandRoomCollapse();
            this.$('roomCodeDisplay').textContent = (this._room.code || '').replace(/(\d)/g, '$1 ').trim();
        } else {
            idle.classList.remove('hidden');
            active.classList.add('hidden');
            this.$('roomCodeInput').value = '';
        }
    },

    async createRoom() {
        const name = this.deviceName || '我的设备';
        console.log('[Room] 创建房间, 设备名:', name, 'deviceId:', this.deviceId);
        if (this._roomCreating) { this.toast('正在创建房间，请稍候', 'info'); return; }
        this._roomCreating = true;
        // 兜底：若 5 秒内未收到 room_created/room_error，提示失败，避免静默无反应
        this._roomCreateTimer = setTimeout(() => {
            if (this._roomCreating) {
                this._roomCreating = false;
                this.toast('创建房间超时，请重试（若持续失败请刷新页面）', 'error');
                console.warn('[Room] 创建房间超时，未收到 room_created');
            }
        }, 5000);
        this.send({ type: 'room_create', payload: { name } });
        this.toast('正在创建房间…', 'info');
    },

    joinRoom() {
        if (this._roomJoining) { this.toast('正在加入房间，请稍候', 'info'); return; }
        // 去除空格与常见分隔符，允许用户输入 "12 34 56" 这类带空格的暗号
        const code = this.$('roomCodeInput').value.replace(/[\s-]/g, '');
        if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) { this.toast('请输入 6 位数字暗号', 'info'); return; }
        console.log('[Room] 加入房间, 暗号:', code, 'deviceId:', this.deviceId);
        this._roomJoining = true;
        this.send({ type: 'room_join', payload: { code } });
        this.toast('正在加入房间…', 'info');
        // 5秒超时兜底
        if (this._roomJoinTimer) clearTimeout(this._roomJoinTimer);
        this._roomJoinTimer = setTimeout(() => {
            if (this._roomJoining) {
                this._roomJoining = false;
                this.toast('加入房间超时，请确认暗号后重试', 'error');
            }
        }, 5000);
    },

    leaveRoom() {
        this._roomCreating = false;
        this._roomJoining = false;
        if (this._roomCreateTimer) { clearTimeout(this._roomCreateTimer); this._roomCreateTimer = null; }
        if (this._roomJoinTimer) { clearTimeout(this._roomJoinTimer); this._roomJoinTimer = null; }
        if (this._autoJoinDelay) { clearTimeout(this._autoJoinDelay); this._autoJoinDelay = null; }
        this.send({ type: 'room_leave' });
        this._room = null;
        this._roomDevices.clear();
        this._hintedLanRoom.clear(); // 重置"同网络提示"记录，下次加入房间可重新提示
        this.renderRoomState();
    },

    copyRoomCode() {
        if (!this._room) return;
        const btn = this.$('roomCodeCopy');
        try {
            const ta = document.createElement('textarea');
            ta.value = this._room.code;
            ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            btn.classList.add('copied');
            this.toast('暗号已复制', 'success');
            setTimeout(() => btn.classList.remove('copied'), 2000);
        } catch { this.toast('复制失败', 'error'); }
    },

    // 房间消息处理
    onRoomCreated(payload) {
        console.log('[Room] 房间已创建:', payload);
        this._roomCreating = false;
        if (this._roomCreateTimer) { clearTimeout(this._roomCreateTimer); this._roomCreateTimer = null; }
        this._room = { id: payload.roomId, code: payload.code, ownerId: payload.ownerId };
        this._roomDevices.clear();
        if (payload.devices) {
            payload.devices.forEach(d => { if (d) this._roomDevices.set(d.id, d); });
        }
        this.renderRoomState();
        this._deviceView = 'room';
        this.renderDevices();
        // 移动端 DOM 操作后可能隐式滚动到房间区域，强制回到顶部
        window.scrollTo({ top: 0, behavior: 'instant' });
        this.updateQRCode();
        this.toast(`房间已创建，暗号：${payload.code}`, 'success');
    },

    onRoomJoined(payload) {
        console.log('[Room] 已加入房间:', payload);
        this._roomJoining = false;
        if (this._roomJoinTimer) { clearTimeout(this._roomJoinTimer); this._roomJoinTimer = null; }
        if (this._autoJoinDelay) { clearTimeout(this._autoJoinDelay); this._autoJoinDelay = null; }
        this._room = { id: payload.roomId, code: payload.code, ownerId: payload.ownerId };
        this._roomDevices.clear();
        if (payload.devices) {
            payload.devices.forEach(d => { if (d) this._roomDevices.set(d.id, d); });
        }
        this.renderRoomState();
        this._deviceView = 'room';
        this.renderDevices();
        // 移动端 DOM 操作后可能隐式滚动到房间区域，强制回到顶部
        window.scrollTo({ top: 0, behavior: 'instant' });
        this.updateQRCode();
        this.toast('加入房间成功', 'success');
    },

    onRoomLeft() {
        this._room = null;
        this._roomDevices.clear();
        this._deviceView = 'lan';
        this.renderRoomState();
        this.renderDevices();
        this.updateQRCode();
        this.toast('已离开房间', 'info');
    },

    onRoomDeviceJoined(device) {
        if (device && device.id) {
            this._roomDevices.set(device.id, device);
            // 有房间成员加入时，若当前停留在局域网视图，自动切到房间视图，
            // 避免对方明明在房间里却被显示在局域网 tab（重大 UX bug）
            if (this._room && this._deviceView !== 'room') {
                this._deviceView = 'room';
            }
            this.renderRoomState();
            this.renderDevices();
            if (device.id !== this.deviceId) this.toast(`${device.name} 加入了房间`, 'info');
        }
    },

    onRoomDeviceLeft(payload) {
        if (payload?.deviceId) {
            const dev = this._roomDevices.get(payload.deviceId);
            this._roomDevices.delete(payload.deviceId);
            this.renderRoomState();
            this.renderDevices();
            if (dev) this.toast(`${dev.name} 离开了房间`, 'info');
        }
    },

    onRoomInfo(payload) {
        if (!payload) return;
        // 仅在确实处于房间（inRoom:true 或同时含 roomId+code）时才设置 _room，
        // 否则视为"未进房间"，清空 _room 走默认发现设备面板，避免 code 为 undefined 崩溃
        const inRoom = payload.inRoom === true || (payload.roomId && payload.code);
        if (inRoom) {
            this._room = { id: payload.roomId, code: payload.code, ownerId: payload.ownerId };
            this._roomDevices.clear();
            if (payload.devices) {
                payload.devices.forEach(d => { if (d) this._roomDevices.set(d.id, d); });
            }
            this.renderRoomState();
            this._deviceView = 'room';
            this.renderDevices();
            this.updateQRCode();
        } else {
            // 仅当本地确实未处于房间时才回落到局域网模式。
            // 防止重连/初始化竞态：后端 GetRoomByDevice 偶发未及时同步返回 inRoom:false，
            // 但本地 _room 仍有效，此时不应清空房间状态，否则房间视图会闪回局域网。
            if (!this._room) {
                this._roomDevices.clear();
                this._deviceView = 'lan';
            }
            this.renderRoomState();
            this.renderDevices();
        }
    },

    onRoomError(payload) {
        this._roomCreating = false;
        this._roomJoining = false;
        if (this._roomCreateTimer) { clearTimeout(this._roomCreateTimer); this._roomCreateTimer = null; }
        if (this._roomJoinTimer) { clearTimeout(this._roomJoinTimer); this._roomJoinTimer = null; }
        if (this._autoJoinDelay) { clearTimeout(this._autoJoinDelay); this._autoJoinDelay = null; }
        console.error('[Room] 房间操作失败:', payload);
        // 修复：后端发送的是 message 字段，不是 error 字段
        this.toast(payload?.message || payload?.error || '房间操作失败', 'error');
    },

    // 网络能力预判：进入页面即静默探测本机候选类型，提前给出跨网互传可行性提示。
    // 不阻塞任何操作（探测失败时隐藏提示，仍可在连接后判定）。
    async probeNetworkCapability() {
        const box = this.$('netCapPill');
        const text = this.$('netCapPillText');
        if (!box || !text) return;
        const hasTurn = !!(this._iceServers && this._iceServers.some(s => (s.urls || '').toString().includes('turn:')));
        let hasV6 = false;
        let hasPublicV4 = false;
        let hasStunPublic = false;
        let localLanIp = ''; // 本机局域网 IP（用于同用户子网判定：热点/WiFi 直连）
        let srflx4 = ''; // mDNS 兜底：STUN 反射的出口 IPv4
        const isPrivateV4 = (addr) => {
            return addr.startsWith('10.') ||
                addr.startsWith('192.168.') ||
                /^172\.(1[6-9]|2\d|3[0-1])\./.test(addr) ||
                addr.startsWith('169.254.') || // 链路本地
                addr.startsWith('100.64.');    // 运营商级 CGNAT 共享地址（打洞受限，非真正公网）
        };
        const isPublicV4 = (addr) => {
            if (!addr || addr.includes(':')) return false;
            // 排除非 IPv4 / 私有网段，即为公网 IPv4
            return !isPrivateV4(addr);
        };
        const isPublicV6 = (addr) => {
            if (!addr || !addr.includes(':')) return false;
            if (addr.startsWith('fe80')) return false;       // 链路本地，不可跨网路由
            if (addr.startsWith('fc') || addr.startsWith('fd')) return false; // 唯一本地 ULA
            if (addr.startsWith('::1')) return false;
            return /^2[0-9a-f]/i.test(addr) || /^3[0-9a-f]/i.test(addr); // 公网 IPv6 (2000::/3)
        };
        try {
            const pc = new RTCPeerConnection({ iceServers: this._iceServers || [] });
            pc.createDataChannel('cap');
            const done = new Promise(resolve => {
                const to = setTimeout(resolve, 2500);
                pc.onicecandidate = (e) => {
                    if (!e.candidate) return;
                    const c = e.candidate.candidate || '';
                    if (c.includes('typ host')) {
                        let addr = (e.candidate.address || '').toLowerCase();
                        if (!addr) {
                            const m = c.match(/(?:candidate:)?\S+ \d+ \S+ \d+ (\S+)/);
                            if (m) addr = m[1];
                        }
                        if (isPublicV6(addr)) hasV6 = true;
                        else if (isPublicV4(addr)) hasPublicV4 = true;
                        else if (addr && isPrivateV4(addr) && !addr.startsWith('169.254.')) {
                            // 多网卡（VPN/Docker/虚拟网卡）时按启发式选"最像真实局域网"的地址：
                            // 192.168.* 优先，其次 10.*，最后 172.16-31.*，避免误报虚拟网卡 IP
                            if (!localLanIp) localLanIp = addr;
                            else if (localLanIp.startsWith('172.') && (addr.startsWith('192.168.') || addr.startsWith('10.'))) localLanIp = addr;
                            else if (localLanIp.startsWith('10.') && addr.startsWith('192.168.')) localLanIp = addr;
                        }
                    }
                    if (c.includes('typ srflx')) {
                        // 仅当反射地址为公网才算具备打洞能力：
                        // 级联 NAT / 内网 STUN 反射出的私网地址无法证明可对外打洞，
                        // 避免误判"已获取公网地址"
                        let saddr = (e.candidate.address || '').toLowerCase();
                        if (!saddr) {
                            const m = c.match(/(?:candidate:)?\S+ \d+ \S+ \d+ (\S+)/);
                            if (m) saddr = m[1];
                        }
                        if (isPublicV4(saddr) || isPublicV6(saddr)) {
                            hasStunPublic = true;
                            if (!srflx4 && isPublicV4(saddr)) srflx4 = saddr;
                        }
                    }
                    // 注意：relay（TURN 中继）候选不算 STUN 打洞能力，避免把"仅配置 TURN"误判为"已获取公网地址"
                };
                pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(to); resolve(); } };
            });
            pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {});
            await done;
            pc.close();
        } catch {}

        let level, msg;
        if (hasStunPublic) {
            // 已拿到公网反射地址（IPv4 打洞或 IPv6 直连）：跨网大概率可传
            level = 'ok';
            msg = '本机网络可跨网互传（已获取公网地址）';
        } else if (hasV6) {
            // 有公网 IPv6 主机候选：与对端 IPv6 可直连
            level = 'ok';
            msg = '本机具备公网 IPv6，可跨网直连';
        } else if (hasPublicV4) {
            // 本机直接持有公网 IPv4（如光猫桥接/服务器），可跨网直连
            level = 'ok';
            msg = '本机具备公网 IPv4，可跨网直连';
        } else if (hasTurn) {
            level = 'ok';
            msg = '已配置 TURN 中继，可跨网互传';
        } else {
            // v2.0.6：无公网IP、无TURN中继。STUN穿透仅在全锥形NAT下可成功，对称NAT必然失败。
            level = 'warn';
            msg = '未配置 TURN 中继，跨网穿透可能失败';
        }
        box.dataset.level = level;
        text.textContent = msg;

        // 上报本机局域网 IP 给服务器：用于"同用户子网"判定（连同一热点/WiFi 即互见直连）
        // mDNS 兜底：移动端浏览器 host candidate 被混淆为 .local 域名，改用 STUN 出口 IP
        if (!localLanIp && srflx4) localLanIp = srflx4;
        if (localLanIp) {
            this._localLanIp = localLanIp;
            // 静默上报：探测可能早于 WS 就绪，此时静默丢弃即可（WS 连接后服务器会重新评估）
            this.send({ type: 'report_lan', payload: { lanIp: localLanIp } }, true);
        }

        // 保存探测结果供设备选择时回写
        this._netCapProbed = true;
        this._natHasTurn = hasTurn;
        this._natHasV6 = hasV6;
        this._natHasPublicV4 = hasPublicV4;
        this._natHasStunPublic = hasStunPublic;
        this._netCapLevel = level;
        this._netCapMsg = msg;

        // 后台验证 TURN 服务器实际可达性（Offer/Answer 触发 relay 候选分配）
        // 仅当 ICE 配置中包含 TURN URL 时才验证；不阻塞首屏渲染
        if (hasTurn) this._verifyTurnReachability();
    },

    // 后台异步验证 TURN 服务器是否真的能分配 relay 候选
    // 使用 dummy PC 完成 Offer/Answer 握手以触发完整 ICE gathering（含 TURN 分配）
    async _verifyTurnReachability() {
        let relayFound = false;
        try {
            const pc = new RTCPeerConnection({ iceServers: this._iceServers || [] });
            pc.createDataChannel('turnchk');
            const done = new Promise(resolve => {
                const to = setTimeout(() => { clearTimeout(to); resolve(); }, 12000);
                pc.onicecandidate = (e) => {
                    if (!e.candidate) { clearTimeout(to); resolve(); return; }
                    const c = e.candidate.candidate || '';
                    if (c.includes('typ relay')) { relayFound = true; clearTimeout(to); resolve(); }
                };
                pc.onicegatheringstatechange = () => {
                    if (pc.iceGatheringState === 'complete') { clearTimeout(to); resolve(); }
                };
            });
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            // Dummy PC 完成 Offer/Answer，触发 iceServers 中的 TURN 分配
            const dp = new RTCPeerConnection();
            await dp.setRemoteDescription(offer);
            const answer = await dp.createAnswer();
            await dp.setLocalDescription(answer);
            await pc.setRemoteDescription(answer);
            await done;
            try { pc.close(); } catch {}
            try { dp.close(); } catch {}
        } catch { /* 验证静默失败，保留原来的 URL-based 判定 */ }
        if (!relayFound) {
            // TURN URL 配置了但 relay 候选未出现 → TURN 不可达，修正标志和 UI
            this._natHasTurn = false;
            this._updateNetCapPill();
            console.warn('[TURN] 服务器不可达，已标记 _natHasTurn=false');
        }
    },

    // 根据当前探测结果刷新网络能力 Pill（_natHasTurn 变更后回写 UI）
    _updateNetCapPill() {
        const box = this.$('netCapPill');
        const text = this.$('netCapPillText');
        if (!box || !text) return;
        let level, msg;
        if (this._natHasStunPublic) {
            level = 'ok'; msg = '本机网络可跨网互传（已获取公网地址）';
        } else if (this._natHasV6) {
            level = 'ok'; msg = '本机具备公网 IPv6，可跨网直连';
        } else if (this._natHasPublicV4) {
            level = 'ok'; msg = '本机具备公网 IPv4，可跨网直连';
        } else if (this._natHasTurn) {
            level = 'ok'; msg = '已配置 TURN 中继，可跨网互传';
        } else {
            level = 'warn'; msg = '未配置 TURN 中继，跨网穿透可能失败';
        }
        box.dataset.level = level;
        text.textContent = msg;
        this._netCapLevel = level;
        this._netCapMsg = msg;
    },

    // 真实连接结果回写网络能力提示
    setNetCapResult(ok, viaTurn) {
        const box = this.$('netCapPill');
        const text = this.$('netCapPillText');
        if (!box || !text) return;
        if (ok) {
            box.dataset.level = 'ok';
            text.textContent = viaTurn ? '已通过 TURN 中继完成跨网传输' : '已成功跨网传输（直连）';
        } else {
            box.dataset.level = 'error';
            text.textContent = this._natHasTurn
                ? '本次跨网连接失败：直连与 TURN 中继均不可用'
                : '未配置 TURN 中继，本次跨网连接失败';
        }
    },

    // 生成/更新 PC 端右侧二维码
    updateQRCode() {
        const img = this.$('qrImg');
        const desc = this.$('qrDesc');
        if (!img || !desc) return;
        if (typeof qrcode === 'undefined') return;

        // 构造 URL：当前页面地址，若在房间中附加暗号
        let url = location.origin + location.pathname;
        if (this._room && this._room.code) {
            url += '?code=' + this._room.code;
            desc.textContent = '扫码加入房间 ' + this._room.code;
        } else {
            desc.textContent = '手机上打开此页面，即可互传文件';
        }

        try {
            const qr = qrcode(0, 'L');
            qr.addData(url);
            qr.make();
            // 根据主题切换 QR 配色
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            // 浅色主题：白底 + 页面文字色模块；深色主题：深色底 + 浅灰模块
            const bg = isDark ? '#1e2024' : '#ffffff';
            const fg = isDark ? '#d1d5db' : '#374151';
            const svg = qr.createSvgTag(4, 2);
            // 替换前景色（模块）和背景色
            const colored = svg
                .replace(/#000000|black/g, fg)
                .replace(/fill:\s*white|fill="white"/g, 'fill="' + bg + '"');
            img.src = 'data:image/svg+xml,' + encodeURIComponent(colored);
        } catch (e) {
            console.warn('[QR] 生成失败:', e);
        }
    },

    // 房间内 WebRTC（通过房间信令）
    async sendFileP2PRoom(file, taskId, toId) {
        const { pc, dc } = await this._connectWithRetry(toId, taskId, true);
        try {
            dc.send(JSON.stringify({ type: 'meta', name: file.name, size: file.size, mime: file.type }));

            const chunkSize = 256 * 1024;
            const total = Math.ceil(file.size / chunkSize);
            const startTime = Date.now();
            let sent = 0;
            let lastProgressUpdate = 0;

            const HIGH_WATERMARK = 8 * 1024 * 1024;
            const LOW_WATERMARK = 2 * 1024 * 1024;
            dc.bufferedAmountLowThreshold = LOW_WATERMARK;

            // 通用 buffer 等待：轮询 bufferedAmount + readyState，不再依赖 onbufferedamountlow 事件
            // （大文件传输中 DC 异常时该事件不触发，导致 30s 超时死等 → send buffer timeout）
            const waitForLow = (timeoutMs = 30000) => {
                const start = Date.now();
                let disconnectedSince = 0;
                return new Promise((resolve, reject) => {
                    const check = () => {
                        const cs = pc.connectionState;
                        if (dc.readyState === 'closed' || dc.readyState === 'closing') {
                            return reject(new Error('发送中断：连接已关闭'));
                        }
                        if (cs === 'failed') {
                            return reject(new Error('发送中断：ICE 连接失败'));
                        }
                        if (cs === 'disconnected') {
                            // 暂时断连（NAT 映射回收 / 中继链路抖动）：等 12s 恢复，超过则判定中断，
                            // 与接收端 10s 重连等待窗口协调，避免发送端死等 30s 后才发现，导致"传一半"无响应
                            if (!disconnectedSince) disconnectedSince = Date.now();
                            else if (Date.now() - disconnectedSince > 12000) {
                                return reject(new Error('发送中断：连接长时间断开'));
                            }
                        } else {
                            disconnectedSince = 0; // 已恢复 connected
                        }
                        if (dc.bufferedAmount <= LOW_WATERMARK) return resolve();
                        if (Date.now() - start > timeoutMs) return reject(new Error('send buffer timeout'));
                        setTimeout(check, 10);
                    };
                    check();
                });
            };
            const waitForBuffer = () => {
                if (dc.bufferedAmount < HIGH_WATERMARK) return Promise.resolve();
                return waitForLow();
            };

            let nextBuf = file.slice(0, chunkSize).arrayBuffer();

            for (let i = 0; i < total; i++) {
                const buf = await nextBuf;
                if (i + 1 < total) {
                    const s = (i + 1) * chunkSize;
                    nextBuf = file.slice(s, Math.min(s + chunkSize, file.size)).arrayBuffer();
                }

                await waitForBuffer();
                try {
                    dc.send(buf);
                } catch {
                    await waitForLow(15000);
                    dc.send(buf);
                }
                sent += buf.byteLength;

                const now = Date.now();
                if (now - lastProgressUpdate > 100 || i === total - 1) {
                    lastProgressUpdate = now;
                    const pct = Math.round(sent / file.size * 100);
                    const speed = sent / ((now - startTime) / 1000 || 1);
                    this.updateProgress(sent, file.size, speed, pct);
                }
            }

            // 发送完成信号：先等缓冲降至低水位，确保 done 能进入发送队列
            // （缓冲满时 dc.send 会抛异常导致 done 丢失 → 接收端"收不完"）；短超时兜底，
            // 连接异常时 waitForLow 抛错由外层 try 捕获，走自动重连重传。
            try { await waitForLow(15000); } catch (e) { throw e; }
            dc.send(JSON.stringify({ type: 'done' }));

            // 等待接收端确认（done_ack）：与 sendFileP2P 一致。
            // 慢速连接（TURN 中继）下最后一批数据可能在缓冲中，且接收端落盘需要时间；
            // 若 5s+3s 就关闭连接，会导致发送端误报完成、接收端仍在接收后报错。
            const acked = await new Promise(resolve => {
                let settled = false;
                const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
                this._sendDoneAckResolve = () => done(true);
                const poll = () => {
                    if (settled) return;
                    if (dc.readyState === 'closed' || dc.readyState === 'closing' || pc.connectionState === 'failed') {
                        return done(false); // 连接已断开，无法收到确认
                    }
                    if (dc.bufferedAmount > 0) return setTimeout(poll, 20);
                    setTimeout(poll, 50);
                };
                poll();
                setTimeout(() => done(false), 60000);
            });
            this._sendDoneAckResolve = null;
            if (acked) {
                this.toast('对方已确认接收完成', 'success');
            } else {
                this.toast('发送完成，但未收到对方确认（请检查接收端文件是否完整）', 'info');
            }
        } finally {
            this._stopDcHeartbeat(dc);
            this._sendDoneAckResolve = null;
            try { dc.close(); } catch {}
            try { pc.close(); } catch {}
            this._sendPC = null;
            this._sendDC = null;
        }
    },

    onWebrtcCandidate(payload) {
        const c = payload.candidate;
        if (!c) return;
        // 按任务 ID 匹配当前活跃的发送/接收 PC，避免同一设备并发收发时候选加错连接
        const taskId = payload.taskId;
        let pc = null;
        if (taskId && this._sendTaskId === taskId) pc = this._sendPC;
        else if (taskId && this._recvTaskId === taskId) pc = this._recvPC;
        else { pc = this._sendPC || this._recvPC; }
        if (!pc) return;
        const cand = new RTCIceCandidate(c);
        // 远端描述未就绪时先缓存，避免 addIceCandidate 报错丢候选
        if (pc.remoteDescription && pc.remoteDescription.type) {
            pc.addIceCandidate(cand).catch(() => {});
        } else {
            pc._candCache = pc._candCache || [];
            pc._candCache.push(cand);
        }
    },

    // ===== 清除数据 =====
    async clearLocalData() {
        if (!confirm('确定清除所有本地数据？\n（将删除所有已接收的文件记录和缓存）')) return;
        await this.dbClear();
        this.receiveHistory = [];
        this.renderReceiveList();
        this.toast('数据已清除', 'success');
        this.closeSettings();
    },

    // ===== WebSocket =====
    connect() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        // 先推导网关基路径，并准备绝对路径回退（兼容飞牛网关是否剥离 /app/fn_qycs/gateway 前缀）
        const basePath = location.pathname.replace(/\/[^/]*$/, '');
        const candidates = [`${proto}//${location.host}${basePath}/ws`];
        const absolute = `${proto}//${location.host}/ws`;
        if (!candidates.includes(absolute)) candidates.push(absolute);
        if (this.deviceName) {
            for (let i = 0; i < candidates.length; i++) candidates[i] += (candidates[i].includes('?') ? '&' : '?') + 'name=' + encodeURIComponent(this.deviceName);
        }
        this._wsCandidates = candidates;
        this._tryConnectWs(0);
    },
    _tryConnectWs(idx) {
        const candidates = this._wsCandidates || [];
        if (idx >= candidates.length) {
            // 所有候选路径都失败，3 秒后从头重试
            console.error('[WS] 所有候选路径均连接失败，稍后重试');
            this.updateStatus('error');
            this.scheduleReconnect();
            return;
        }
        const url = candidates[idx];
        console.log(`[WS] 尝试连接 (${idx + 1}/${candidates.length}):`, url);
        this.updateStatus('connecting');
        let ws;
        try { ws = new WebSocket(url); } catch (e) { console.error('[WS] 创建失败', e); this._tryConnectWs(idx + 1); return; }
        this.ws = ws;
        ws.onopen = () => {
            this._everConnected = true;
            console.log('[WS] 已连接');
            this.updateStatus('connected');
            if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
            this.startHeartbeat();
        };
        ws.onmessage = (e) => {
            try { this.onMessage(JSON.parse(e.data)); }
            catch (err) { console.error('[WS] 消息处理错误:', err, e.data?.substring(0, 200)); }
        };
        ws.onclose = (e) => {
            console.warn(`[WS] 连接关闭 code=${e.code} reason=${e.reason || '(空)'} wasClean=${e.wasClean}`);
            this.stopHeartbeat();
            // 非正常关闭（如网关路径不匹配 1006）且还有候选路径未试，则切换路径重试；否则常规重连
            if (!e.wasClean && !this._everConnected && idx + 1 < candidates.length) {
                console.warn('[WS] 当前路径失败，尝试回退路径');
                this._tryConnectWs(idx + 1);
                return;
            }
            this.updateStatus('error');
            this.scheduleReconnect();
        };
        ws.onerror = (e) => {
            console.error('[WS] 连接错误', e?.message || '');
        };
        // 修复：以下重复赋值会覆盖上面的处理器（this.ws === ws），
        // 且丢失了 onclose 中的路径回退逻辑（反代场景下 /ws 失败后不会尝试回退路径），
        // 已删除。
    },
    scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, 3000);
    },
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.send({ type: 'heartbeat' });
                // 同时请求最新设备列表（持续发现新设备）
                this.send({ type: 'request_device_list' });
            }
        }, 20000); // 每 20 秒发送心跳（服务端超时 45s）
    },
    stopHeartbeat() { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } },

    // 手动刷新设备列表
    refreshDevices() {
        const btn = this.$('refreshDevices');
        btn.classList.add('spinning');
        setTimeout(() => btn.classList.remove('spinning'), 600);
        this.send({ type: 'request_device_list' });
        this.toast('正在搜索设备…', 'info');
    },
    send(msg, silent = false) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        } else if (!silent) {
            console.warn('[WS] 连接未就绪，无法发送:', msg.type);
            this.toast('连接未就绪，请稍后重试', 'error');
        }
    },

    onMessage(msg) {
        switch (msg.type) {
            case 'welcome': this.onWelcome(msg.payload); break;
            case 'lan_only': this.onLanOnly(msg.payload); break;
            case 'device_list': this.onDeviceList(msg.payload); break;
            case 'device_online': this.onDeviceOnline(msg.payload); break;
            case 'device_offline': this.onDeviceOffline(msg.payload); break;
            case 'device_name_updated': this.onDeviceNameUpdated(msg.payload); break;
            case 'transfer_request': this.onTransferRequest(msg.payload); break;
            case 'transfer_accept': this.onTransferAccept(msg.payload); break;
            case 'transfer_reject': this.onTransferReject(msg.payload); break;
            case 'transfer_complete': this.onTransferComplete(msg.payload); break;
            case 'transfer_cancel': this.onTransferCancel(msg.payload); break;
            // WebRTC P2P 信令（局域网直连）
            case 'webrtc_offer': this.onWebrtcOffer(msg.payload, false); break;
            case 'webrtc_answer': this.onWebrtcAnswer(msg.payload); break;
            case 'webrtc_candidate': this.onWebrtcCandidate(msg.payload); break;
            // 房间消息（公网互传）
            case 'room_created': this.onRoomCreated(msg.payload); break;
            case 'room_joined': this.onRoomJoined(msg.payload); break;
            case 'room_left': this.onRoomLeft(); break;
            case 'room_device_joined': this.onRoomDeviceJoined(msg.payload); break;
            case 'room_device_left': this.onRoomDeviceLeft(msg.payload); break;
            case 'room_info': this.onRoomInfo(msg.payload); break;
            case 'room_error': this.onRoomError(msg.payload); break;
            case 'room_webrtc_offer': this.onWebrtcOffer(msg.payload, true, msg.fromId); break;
            case 'room_webrtc_answer': this.onWebrtcAnswer(msg.payload, msg.fromId); break;
            case 'room_webrtc_candidate': this.onWebrtcCandidate(msg.payload, msg.fromId); break;
        }
    },

    // ===== WS 事件处理 =====
    onWelcome(payload) {
        this.deviceId = payload.deviceId;
        if (payload.device?.name) {
            this.deviceName = payload.device.name;
            localStorage.setItem('yuanbaba_name', this.deviceName);
        }
        // A 方案：同作用域内昵称冲突被服务器自动加序号去重时，提示用户
        if (payload.nameAdjusted && payload.finalName) {
            this.deviceName = payload.finalName;
            localStorage.setItem('yuanbaba_name', this.deviceName);
            this.toast('昵称「' + (payload.device?.name || '') + '」已被占用，已自动改为「' + payload.finalName + '」', 'info');
        }
        this.$('selfName').textContent = this.deviceName || '未命名';
        this._myIP = payload.device?.ip || '';
        this.updateStatus('connected');
        // 连接建立后立即拉取一次设备列表，避免等到首个心跳才看到附近设备
        this.send({ type: 'request_device_list' });
        // 复位模式标记，等待服务器返回 device_list / lan_only 后再确定
        this._modeDetermined = false;
        // 刷新后若仍在房间，恢复房间态（后端持久保存房间，重连仍在原房间）
        this.send({ type: 'room_list' });
        // 扫码加入房间：URL 中带了 ?code=XXXXXX 参数，自动加入
        const params = new URLSearchParams(location.search);
        const urlCode = params.get('code');
        if (urlCode && /^\d{6}$/.test(urlCode)) {
            console.log('[Room] 检测到 URL 暗号:', urlCode, '当前房间态:', !!this._room);
            // 已在房间中则跳过（可能是重连恢复）
            if (this._room) return;
            // 自动填入暗号
            this.$('roomCodeInput').value = urlCode;
            // 自动展开房间面板
            const body = this.$('roomBody');
            if (body && body.classList.contains('hidden')) this.expandRoomCollapse();
            // 清除旧定时器，重新设置（WS 每次重连都重新尝试，确保最终能加入）
            if (this._autoJoinDelay) clearTimeout(this._autoJoinDelay);
            this._autoJoinDelay = setTimeout(() => {
                if (!this._room && !this._roomJoining) {
                    // 重新写入暗号（onRoomInfo → renderRoomState 可能已清空 input）
                    this.$('roomCodeInput').value = urlCode;
                    console.log('[Room] 开始自动加入房间:', urlCode);
                    this.joinRoom();
                }
            }, 1500);
        }
    },

    // 公网受限模式：服务器判定当前客户端非局域网，不发现局域网设备。
    // 自动切换至房间 tab，引导用户通过暗号房间互传。
    //
    // v2.0.6 修复：不再立即清空 devices 和强制切换视图。
    // 公网反代部署场景下，后端已启动多轮重试等待 LocalLanIP 上报，
    // 若 5 秒内收到 device_list 或 device_online，则自动反转为局域网模式。
    onLanOnly(payload) {
        const firstTime = !this._modeDetermined;
        this._modeDetermined = true;
        if (firstTime) {
            // 仅标记等待状态，不立即清空列表也不强制切换视图
            this._isPublicMode = true;
            this.$('statusText').textContent = '公网模式';
            // 启动 5 秒宽容窗口：在此期间若收到 device_online 或 device_list，会由对应处理函数反转
            this._lanOnlyRecoveryTimer = setTimeout(() => {
                this._lanOnlyRecoveryTimer = null;
                // 宽容期结束，确认仍为公网模式，此时才清空列表并引导房间
                if (this._isPublicMode && !this._room) {
                    this.devices.clear();
                    this._deviceView = 'room';
                    this.expandRoomCollapse();
                    this.toast('当前公网模式，请使用跨网络互传（暗号房间）进行传输', 'info');
                    this.renderDevices();
                }
            }, 5000);
        }
        // 非首次不覆盖 _isPublicMode / statusText，避免覆盖 report_lan 维度2 恢复的局域网状态
        this.updateStatus('connected');
        // 不在首次立即 renderDevices，让宽容期窗口保持设备列表
        if (!firstTime) {
            this.renderDevices();
        }
    },

    onDeviceList(devices) {
        const list = devices || [];
        // v2.0.6：收到 device_list 时取消 lan_only 宽容期定时器
        if (this._lanOnlyRecoveryTimer) {
            clearTimeout(this._lanOnlyRecoveryTimer);
            this._lanOnlyRecoveryTimer = null;
        }
        // 仅在首次模式判断时更新 _isPublicMode，防止 report_lan 的 device_list 响应误翻转
        if (!this._modeDetermined) {
            this._isPublicMode = false;
            this._modeDetermined = true;
        }
        // 若此前因 lan_only 被强制切到 room 视图但实际未入房间，现在收到 device_list 说明有同子网设备，
        // 需要自动切回 LAN 视图（否则设备存入 this.devices 但渲染只看 _roomDevices，什么都看不到）
        if (this._deviceView === 'room' && !this._room) {
            this._deviceView = 'lan';
            this._isPublicMode = false;
        }
        this.$('statusText').textContent = '局域网模式';
        // [DEV] 调试日志：打印设备数量。若已连(有 welcome 日志)但数量为 0，多为同分组内仅自己在线(正常隔离)
        console.log(`[DEV] 收到 device_list, 设备数=${list.length}`, list.map(d => d.name));
        // 合并而非清空：避免设备闪烁，同时去掉已不存在的设备
        const newIds = new Set();
        list.forEach(d => {
            // 严格排除自己：id 非空且不等于当前 deviceId
            if (d.id && d.id !== this.deviceId) {
                // 若该设备已是房间成员，跳过写入局域网列表，避免同网段房间成员双存
                if (!this._roomDevices.has(d.id)) {
                    newIds.add(d.id);
                    this.devices.set(d.id, d);
                } else {
                    newIds.add(d.id);
                    // v2.0.7：房间成员被同网络发现，提示可直接局域网互传（无需走房间）。
                    // 服务器会多次推送 device_list（设备上线、report_lan 回推、reEvaluate 等），
                    // 同一设备只提示一次，避免重复 toast。
                    if (d.matchType && (d.matchType === 'local_lan' || d.matchType === 'same_public_ip')) {
                        if (!this._hintedLanRoom.has(d.id)) {
                            this._hintedLanRoom.add(d.id);
                            this.toast(`${d.name} 与你在同一网络，退出房间可直连更快`, 'info');
                        }
                    }
                }
            }
        });
        // 删除已不存在的设备
        for (const id of this.devices.keys()) {
            if (!newIds.has(id)) this.devices.delete(id);
        }
        this._scheduleRender();
    },

    onDeviceOnline(device) {
        console.log('[WS] 设备上线:', device.name, device.id?.substring(0, 10), '我的ID:', this.deviceId?.substring(0, 10));
        if (device.id === this.deviceId) return;
        // 房间成员不写入局域网列表，避免同网段房间成员双存
        if (this._roomDevices.has(device.id)) return;
        // v2.0.6：收到 device_online 时取消 lan_only 宽容期定时器
        if (this._lanOnlyRecoveryTimer) {
            clearTimeout(this._lanOnlyRecoveryTimer);
            this._lanOnlyRecoveryTimer = null;
        }
        const isNew = !this.devices.has(device.id);
        // 保留 device_list 已设置的 matchType（BroadcastLan 广播的 device_online 不含 matchType）
        const existing = this.devices.get(device.id);
        if (existing && existing.matchType && !device.matchType) {
            device.matchType = existing.matchType;
        }
        this.devices.set(device.id, device);
        // 若此前因 lan_only 被强制切到 room 视图但实际未入房间，现在发现同子网设备，自动切回 LAN
        if (this._deviceView === 'room' && !this._room) {
            this._deviceView = 'lan';
            this._isPublicMode = false;
            this.$('statusText').textContent = '局域网模式';
        }
        // 公网模式 + 未入房间时收到设备上线：主动请求设备列表，触发维度3（同公网出口）重新评估
        if (this._isPublicMode) {
            this.send({ type: 'request_device_list' });
        }
        this._scheduleRender();
        if (isNew) this.toast(`${device.name} 已加入`, 'info');
    },

    onDeviceOffline(payload) {
        const dev = this.devices.get(payload.deviceId);
        this.devices.delete(payload.deviceId);
        if (this.selectedTarget === payload.deviceId) { this.selectedTarget = null; this.updateSendBar(); }
        this._scheduleRender();
        if (dev) this.toast(`${dev.name} 已离开`, 'info');
    },

    onDeviceNameUpdated(payload) {
        const dev = this.devices.get(payload.deviceId);
        if (dev) { dev.name = payload.name; this._scheduleRender(); }
        if (this.selectedTarget === payload.deviceId) this.updateSendBar();
    },

    // ===== 设置 =====
    openSettings() {
        this.$('nameInput').value = this.deviceName;
        this.$('settingsOverlay').classList.remove('hidden');
    },
    closeSettings() { this.$('settingsOverlay').classList.add('hidden'); },
    openAbout() {
        const v = this.$('aboutVersion');
        if (v) {
            v.textContent = 'v' + VERSION;
            v.href = 'https://github.com/Contribuv/fn_qycs';
        }
        this.$('aboutOverlay').classList.remove('hidden');
    },
    closeAbout() { this.$('aboutOverlay').classList.add('hidden'); },
    saveName(name) {
        if (!name || name === this.deviceName) return;
        this.deviceName = name;
        localStorage.setItem('yuanbaba_name', name);
        this.send({ type: 'update_name', payload: { name } });
        this.$('selfName').textContent = name;
        this.toast('名字已更新', 'success');
    },

    // ===== 设备渲染 =====
    // 防抖渲染：150ms 内连续调用只触发一次，避免设备列表频繁刷新闪烁
    _scheduleRender() {
        if (this._renderTimer) return;
        this._renderTimer = setTimeout(() => {
            this._renderTimer = null;
            this.renderDevices();
        }, 150);
    },

    renderDevices() {
        const grid = this.$('deviceGrid');
        const empty = this.$('emptyDevices');
        const count = this.$('deviceCount');
        const scroll = this.$('deviceScroll');
        const emptyHint = this.$('emptyDevicesHint');

        // 合并局域网设备 + 房间成员，去重（房间成员优先），排除本设备
        const merged = new Map();
        this.devices.forEach(d => { if (d.id && d.id !== this.deviceId) merged.set(d.id, d); });
        this._roomDevices.forEach(d => { if (d.id && d.id !== this.deviceId) merged.set(d.id, d); });
        const arr = Array.from(merged.values());
        count.textContent = arr.length;

        // 同步 tab 高亮
        this.$('deviceTabLan').classList.toggle('active', this._deviceView === 'lan');
        this.$('deviceTabRoom').classList.toggle('active', this._deviceView === 'room');
        const roomDisabled = !this._room;
        this.$('deviceTabRoom').classList.toggle('disabled', roomDisabled);

        if (arr.length === 0) {
            grid.innerHTML = '';
            empty.classList.remove('hidden');
            scroll.classList.add('hidden');
            if (emptyHint) {
                if (this._room) {
                    emptyHint.textContent = '暂无设备，邀请对方输入相同房间号加入';
                } else if (this._isPublicMode) {
                    // 公网模式：引导用户使用跨网络互传（暗号房间）
                    emptyHint.textContent = '当前公网模式，请展开「跨网络互传」创建或加入房间';
                } else {
                    emptyHint.textContent = '请确认双方连接同一 WiFi';
                }
            }
            return;
        }
        empty.classList.add('hidden');
        scroll.classList.remove('hidden');

        // 昵称去重：列表中若出现相同昵称，追加简短区分标识，保证视觉上不重复
        const nameCount = {};
        arr.forEach(d => { const n = d.name || '未知'; nameCount[n] = (nameCount[n] || 0) + 1; });
        const nameSeen = {};
        const displayName = (d) => {
            const n = d.name || '未知';
            if (nameCount[n] <= 1) return n;
            nameSeen[n] = (nameSeen[n] || 0) + 1;
            return `${n} (${nameSeen[n]})`;
        };

        grid.innerHTML = arr.map(d => `
            <div class="device-card ${this.selectedTarget === d.id ? 'selected' : ''}" data-id="${this.escape(d.id)}">
                <div class="device-name">${this.escape(displayName(d))}</div>
                <div class="device-meta">
                    <span class="device-meta-ip">${this.deviceDisplayIP(d)}</span>
                    <span class="device-meta-dot"></span>
                    <span class="device-meta-status">${this._deviceView === 'room' ? '房间' : '在线'}</span>
                </div>
            </div>
        `).join('');

        grid.querySelectorAll('.device-card').forEach(el => {
            el.addEventListener('click', () => this.selectDevice(el.dataset.id));
        });
    },

    // 切换设备列表视图（局域网 / 房间）
    setDeviceView(view) {
        if (view === 'room' && !this._room) { this.toast('请先加入或创建房间', 'info'); return; }
        if (this._deviceView === view) return;
        this._deviceView = view;
        // 切换视图后，若当前选中目标不在新视图的数据源中，则取消选择
        if (this.selectedTarget) {
            const inView = view === 'room'
                ? this._roomDevices.has(this.selectedTarget)
                : this.devices.has(this.selectedTarget);
            if (!inView) this.selectedTarget = null;
        }
        this.renderDevices();
        this.renderRoomState();
        this.updateSendBar();
    },

    selectDevice(id) {
        this.selectedTarget = this.selectedTarget === id ? null : id;
        this.renderDevices();
        this.renderRoomState();
        this.updateSendBar();
        this._updateNetCapPill(this.selectedTarget);
    },

    // 兼容局域网与房间（跨网）两种目标来源
    getTarget(id) {
        if (!id) return null;
        return this.devices.get(id) || this._roomDevices.get(id) || null;
    },

    // ===== 文件 =====
    addFiles(files) {
        if (!files?.length) return;
        const MAX_FILE_SIZE = this._maxFileSizeMB * 1024 * 1024; // 动态获取，默认50MB
        const oversized = [];
        for (const f of files) {
            if (f.size > MAX_FILE_SIZE) { oversized.push(f); }
        }
        if (oversized.length) {
            this.showSizeLimitAlert(oversized);
            return;
        }
        this.selectedFiles = files;
        this.renderFileQueue();
        this.updateSendBar();
    },
    removeFile(idx) { this.selectedFiles.splice(idx, 1); this.renderFileQueue(); this.updateSendBar(); },
    clearFiles() { this.selectedFiles = []; this.renderFileQueue(); this.updateSendBar(); },

    renderFileQueue() {
        const q = this.$('fileQueue');
        const cb = this.$('clearBtn');
        if (this.selectedFiles.length === 0) { q.innerHTML = ''; cb.classList.add('hidden'); return; }
        cb.classList.remove('hidden');
        q.innerHTML = this.selectedFiles.map((f, i) => `
            <div class="file-item">
                <div class="file-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></div>
                <div class="file-info">
                    <div class="file-info-name">${this.escape(f.name)}</div>
                    <div class="file-info-size">${this.formatSize(f.size)}</div>
                </div>
                <button class="file-remove" data-idx="${i}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
        `).join('');
        q.querySelectorAll('.file-remove').forEach(btn => {
            btn.addEventListener('click', () => this.removeFile(parseInt(btn.dataset.idx, 10)));
        });
    },

    updateSendBar() {
        const bar = this.$('sendBar');
        const tn = this.$('targetName');
        const sb = this.$('sendBtn');
        if (this.selectedFiles.length === 0) { bar.classList.add('hidden'); return; }
        bar.classList.remove('hidden');
        if (this.selectedTarget) {
            const dev = this.getTarget(this.selectedTarget);
            tn.textContent = dev ? dev.name : '—';
            sb.disabled = !dev || this.activeUpload;
        } else {
            tn.textContent = '选择设备';
            sb.disabled = true;
        }
    },

    // 根据所选设备更新跨网络能力 pill 文本（选择前即给用户 NAT 穿透预期）
    //
    // v2.0.6 修正：不再简单依赖 this.devices.has(id) 判断"同局域网 P2P 直连"。
    // 服务器通过 sameSubnetWithType 在 device_list 中为每个设备附带了 matchType，
    // 区分真正的同局域网设备（local_lan）和仅同公网出口的设备（same_public_ip）。
    _updateNetCapPill(id) {
        const box = this.$('netCapPill');
        const text = this.$('netCapPillText');
        if (!box || !text) return;

        // 未选择设备
        if (!id) {
            box.dataset.level = 'unknown';
            text.textContent = '选择设备查看连接方式';
            return;
        }

        const target = this.getTarget(id);
        if (!target) { box.dataset.level = 'unknown'; text.textContent = '设备已离线'; return; }

        // 网络能力探测尚未完成：不给出"无法传输"等悲观结论，提示检测中即可
        if (!this._netCapProbed) {
            box.dataset.level = 'unknown';
            text.textContent = '正在检测网络能力…';
            return;
        }

        // 服务器附带的匹配维度标记（v2.0.6 新增）
        const mt = target.matchType || '';

        // 维度2（local_lan）/ 维度1（server_lan）/ 维度1.5（private_prefix）：真正的同局域网，可 P2P 直连
        if (mt === 'local_lan' || mt === 'server_lan' || mt === 'private_prefix' || mt === 'cross_lan') {
            box.dataset.level = 'ok';
            text.textContent = '同局域网，P2P 直连 ✓';
            return;
        }

        // 维度3（same_public_ip）：同公网出口但可能不在同一子网，优先 STUN 穿透直连
        if (mt === 'same_public_ip') {
            box.dataset.level = 'warn';
            if (this._natHasStunPublic) {
                text.textContent = '同公网出口，STUN 穿透直连';
            } else if (this._natHasTurn) {
                text.textContent = '同公网出口，可通过 TURN 中继';
            } else {
                text.textContent = '同公网出口，将尝试 STUN 穿透';
            }
            return;
        }

        // 无 matchType（旧版兼容 or 房间成员）：走原有逻辑
        // this.devices 中无 matchType 的设备（如 device_online 广播的）回退到基于 LocalLanIP 的判断
        if (this.devices.has(id)) {
            if (target.localLanIp && this._localLanIp &&
                this._samePrefix(target.localLanIp, this._localLanIp)) {
                box.dataset.level = 'ok';
                text.textContent = '同局域网，P2P 直连 ✓';
            } else {
                box.dataset.level = 'warn';
                text.textContent = '同公网出口，将尝试 STUN 穿透';
            }
            return;
        }

        // 房间成员回退（_roomDevices 中无 matchType，但可能实际在同一局域网）
        if (this._roomDevices.has(id)) {
            // 优先级1：同局域网前缀 → 直连
            if (target.localLanIp && this._localLanIp &&
                this._samePrefix(target.localLanIp, this._localLanIp)) {
                box.dataset.level = 'ok';
                text.textContent = '同局域网，P2P 直连 ✓';
                return;
            }
            // 优先级2：同公网出口 IP → NAT 可直连
            if (target.ip && this._myIP && target.ip === this._myIP) {
                box.dataset.level = 'warn';
                text.textContent = this._natHasStunPublic
                    ? '同公网出口，NAT 可直连'
                    : '同公网出口，将尝试 STUN 穿透';
                return;
            }
            // 优先级3：对方 ip 与本地 localLanIp 同前缀（热点场景反向匹配）
            if (target.ip && this._localLanIp &&
                this._samePrefix(target.ip, this._localLanIp)) {
                box.dataset.level = 'ok';
                text.textContent = '同局域网，P2P 直连 ✓';
                return;
            }
        }

        // 跨网络：直连能力优先（IPv6 直连 > 公网 IPv4 直连 > STUN NAT 穿透），
        // TURN 中继仅作最后兜底提示，避免"明明能直连却提示走慢速中继"误导用户
        if (this._natHasV6) {
            box.dataset.level = 'ok';
            text.textContent = '跨网络，可通过公网 IPv6 直连';
        } else if (this._natHasPublicV4) {
            box.dataset.level = 'ok';
            text.textContent = '跨网络，可通过公网 IPv4 直连';
        } else if (this._natHasStunPublic) {
            box.dataset.level = 'warn';
            text.textContent = '跨网络，STUN 穿透直连（已获取公网地址）';
        } else if (this._natHasTurn) {
            box.dataset.level = 'ok';
            text.textContent = '跨网络，可使用 TURN 中继';
        } else {
            box.dataset.level = 'error';
            text.textContent = '未配置 TURN 中继，无法传输';
        }
    },

    // 判断两个 IP 是否在同一 /24 前缀（辅助 _updateNetCapPill 回退逻辑）
    _samePrefix(ipA, ipB) {
        if (!ipA || !ipB) return false;
        const a = ipA.split('.');
        const b = ipB.split('.');
        if (a.length !== 4 || b.length !== 4) return false;
        return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
    },

    // ===== 发送（WebRTC P2P 直传）=====
    async startSend() {
        if (this.activeUpload) return;
        if (!this.selectedFiles.length || !this.selectedTarget) { this.toast('请选择文件和接收方', 'info'); return; }
        const target = this.getTarget(this.selectedTarget);
        if (!target) { this.toast('设备已离线', 'error'); return; }

        this.centerToast(`正在发起连接到 ${target.name}…`, 'info');

        // v2.0.6：跨网络传输且无直连能力（TURN/公网 IPv6/公网 IPv4 均无）时，前置提醒用户。
        // 有任一直接通路时不再提示"未配置 TURN 中继"，避免误导。
        const lanTypes = ['local_lan', 'server_lan', 'private_prefix', 'cross_lan'];
        const isRoomCrossNet = this._room && this._roomDevices.has(target.id) && !lanTypes.includes(target.matchType);
        const isCrossNet = isRoomCrossNet || target.matchType === 'same_public_ip';
        if (isCrossNet && !this._natHasTurn && !this._natHasV6 && !this._natHasPublicV4) {
            this.toast('未配置 TURN 中继，穿透若失败请在「传送设置」中配置', 'info');
        }

        this.activeUpload = true;
        this._sendCancelled = false; // 本轮发送的取消标记（cancelTransfer 置位，循环/重传据此立即停止）
        this.updateSendBar();
        this.requestWakeLock();  // 传输期间保持屏幕常亮

        const files = [...this.selectedFiles];
        let lastErr = null;
        // 超时按总文件大小动态计算（~2s/MB，最少 120s，最多 1h）
        const totalSize = files.reduce((s, f) => s + f.size, 0);
        const timeoutSec = Math.max(120, Math.min(3600, totalSize / (1024 * 1024) * 2));
        const overallTimeout = setTimeout(() => {
            if (this.activeUpload) {
                console.warn(`[startSend] 总发送时长超过 ${timeoutSec}s，强制结束`);
                this.toast('发送超时已强制结束', 'error');
                try { this.showProgressDone(); } catch (e) { this.closeProgress(); }
                this.cleanupAllTransfers();
            }
        }, timeoutSec * 1000);
        for (let fi = 0; fi < files.length; fi++) {
            // 超过总时长则中断循环（避免 overallTimeout 设置 activeUpload=false 后仍继续发送）
            if (!this.activeUpload) break;
            lastErr = null;
            const file = files[fi];
            try {
                const label = files.length > 1 ? `发送中 (${fi + 1}/${files.length})` : '发送中';
                this.openProgress(file.name, label);

                const taskId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
                // 立即记录当前任务，否则等待接收方确认阶段 _sendTaskId 仍为 null，
                // 此时点取消 cancelTransfer 拿不到 taskId，transfer_cancel 发不出去
                this._sendTaskId = taskId;

                // 通过 WS 发送传输请求（服务器只做信令转发）
                this.send({
                    type: 'transfer_request',
                    payload: { taskId, fileName: file.name, fileSize: file.size, toId: target.id, fromId: this.deviceId, fromName: this.deviceName, index: fi, total: files.length }
                });

                const acceptResult = await this.waitForAccept(taskId, 60000);
                if (this._sendCancelled) { this.closeProgress(); break; } // 本端已取消
                if (acceptResult === 'timeout') { this.toast(`${target.name} 未响应，已跳过 ${file.name}`, 'info'); this.closeProgress(); continue; }
                if (acceptResult !== 'accepted') { this.toast(`${target.name} 拒绝了 ${file.name}`, 'info'); this.closeProgress(); continue; }

                // P2P 直传：文件数据通过 WebRTC DataChannel，不经过服务器。
                // 断流自动重连重传：TURN 中继抖动 / NAT 映射被回收导致传输中途断开时，
                // 自动重建连接并重传当前文件（接收端收到新 offer 会清理旧连接、重置状态后重新接收），
                // 最多重试 2 次，避免跨网传输一断流就只能报错重来。
                let sendErr = null;
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        if (this._room && this._roomDevices.has(target.id)) {
                            await this.sendFileP2PRoom(file, taskId, target.id);
                        } else {
                            await this.sendFileP2P(file, taskId, target.id);
                        }
                        sendErr = null;
                        break;
                    } catch (err) {
                        sendErr = err;
                        // 本端已取消：即使传输中断也不再重传，立即结束
                        if (this._sendCancelled) break;
                        if (!this._isConnDroppedError(err) || attempt >= 2) break;
                        console.warn(`[startSend] 传输中断，自动重连重传 ${file.name}（第 ${attempt + 2}/3 次尝试）:`, err.message);
                        this.centerToast(`连接中断，正在自动重连重传 ${file.name}…`, 'info');
                        // 稍等片刻，让接收端清理旧连接、释放旧连接相关资源
                        await new Promise(r => setTimeout(r, 1500));
                    }
                }
                if (sendErr) {
                    lastErr = sendErr;
                    this.closeProgress();
                } else {
                    this.showProgressDone();
                }
            } catch (err) {
                lastErr = err;
                this.closeProgress();
            }
            // 每发送完一个文件后额外检查是否被超时中断（多文件场景中途超时）
            if (!this.activeUpload) break;
        }
        // 始终提示完成 toast，避免弹窗未自动关闭时用户误以为还在传输中
        clearTimeout(overallTimeout);
        if (lastErr) {
            this.toast(lastErr.message, 'error');
        } else {
            this.toast(files.length > 1 ? '全部发送完成' : '发送完成', 'success');
        }
        this.cleanupAllTransfers();
    },

    // 返回 'accepted' / 'rejected' / 'timeout' / 'cancelled'（本端主动取消），
    // 区分对方明确拒绝、超时未响应与本端取消
    waitForAccept(taskId, timeout) {
        return new Promise(resolve => {
            this._acceptWaiters.set(taskId, resolve);
            const timer = setTimeout(() => { this._acceptWaiters.delete(taskId); this._acceptHandlers.delete(taskId); this._rejectHandlers.delete(taskId); resolve('timeout'); }, timeout);
            this._acceptHandlers.set(taskId, () => { clearTimeout(timer); this._acceptWaiters.delete(taskId); this._acceptHandlers.delete(taskId); this._rejectHandlers.delete(taskId); resolve('accepted'); });
            this._rejectHandlers.set(taskId, () => { clearTimeout(timer); this._acceptWaiters.delete(taskId); this._acceptHandlers.delete(taskId); this._rejectHandlers.delete(taskId); resolve('rejected'); });
        });
    },

    // 传输中断类错误（可自动重连重传）：背压超时、连接被关闭、ICE 失败、长时间断开。
    // 仅这些错误触发重传；用户取消/拒绝/文件读取失败等不重试。
    _isConnDroppedError(err) {
        const m = (err && err.message) || '';
        return m.includes('send buffer timeout') ||
            m.includes('发送中断：连接已关闭') ||
            m.includes('发送中断：ICE 连接失败') ||
            m.includes('发送中断：连接长时间断开');
    },

    // 建立发送端 WebRTC 连接（仅建立连接并等待 DataChannel 打开，不含文件数据发送）
    // isRoom=true 走房间信令；返回 { pc, dc }。直连模式（无 TURN）失败/超时会静默抛错，
    // 交由 _connectWithRetry 决定是否降级 TURN；完整模式失败则正常走 _onConnectionState 报错路径。
    async _connectSendPC(toId, taskId, isRoom) {
        const candType = isRoom ? 'room_webrtc_candidate' : 'webrtc_candidate';
        const offerType = isRoom ? 'room_webrtc_offer' : 'webrtc_offer';
        const isCross = !!(this._room && this._roomDevices.has(toId));
        const cfg = await this._getIceServersForConnection(true);
        const pc = new RTCPeerConnection({ iceServers: cfg.servers });
        const dc = pc.createDataChannel('file', { ordered: true });
        let rejectDcReady;
        let connectTimer, finalTimer;
        const dcReady = new Promise((resolve, reject) => {
            dc.onopen = () => {
                clearTimeout(connectTimer);
                clearTimeout(finalTimer);
                this._startDcHeartbeat(dc);
                if (this._lastViaTurn !== undefined) this.setNetCapResult(true, this._lastViaTurn);
                resolve();
            };
            dc.onerror = () => {
                clearTimeout(connectTimer);
                clearTimeout(finalTimer);
                reject(new Error('连接失败'));
            };
            rejectDcReady = reject;
        });
        dc.onmessage = (event) => {
            let msg = null;
            try { msg = JSON.parse(event.data); } catch {}
            if (msg && msg.type === 'done_ack' && this._sendDoneAckResolve) {
                this._sendDoneAckResolve();
                this._sendDoneAckResolve = null;
            }
        };
        // Trickle ICE：候选边收集边转发
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.send({ type: candType, payload: { toId, taskId, candidate: e.candidate.toJSON() } });
            }
        };
        pc.onconnectionstatechange = () => {
            // 已被重试/取消清理的旧连接：忽略其状态回调，避免取消或重建后误报"跨网连接失败"
            if (this._sendPC !== pc) return;
            const state = pc.connectionState;
            if (state === 'connected') {
                this._onConnectionState(pc, isCross, 'send');
            } else if (state === 'failed') {
                clearTimeout(connectTimer);
                clearTimeout(finalTimer);
                if (!cfg.useFull) {
                    // 直连（无 TURN）失败：不弹错误提示，静默抛错交由 _connectWithRetry 降级 TURN
                    rejectDcReady(new Error('直连穿透失败'));
                } else {
                    this._onConnectionState(pc, isCross, 'send');
                    rejectDcReady(new Error('ICE 连接失败'));
                }
            }
        };
        dc.onclose = () => { this._stopDcHeartbeat(dc); };
        this._sendPC = pc;
        this._sendDC = dc;
        this._sendTaskId = taskId;

        // 连接超时：直连模式 12s（快速降级 TURN），完整模式 30s；另有 45s 最终兜底
        const connectTimeout = cfg.useFull ? 30000 : 12000;
        connectTimer = setTimeout(() => {
            if (pc.connectionState !== 'connected') rejectDcReady(new Error(cfg.useFull ? '连接建立超时' : '直连建立超时'));
        }, connectTimeout);
        finalTimer = setTimeout(() => rejectDcReady(new Error('连接建立超时（45s），网络可能受限')), 45000);

        // 创建 offer，Trickle：立即发送 offer，候选后续通过信令补发
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.send({ type: offerType, payload: { toId, taskId, sdp: pc.localDescription.toJSON() } });

        await dcReady;
        return { pc, dc };
    },

    // 发送端连接重试：直连（仅 STUN，NAT 打洞）失败后自动降级为完整列表（TURN 中继）重试一次
    async _connectWithRetry(toId, taskId, isRoom) {
        try {
            const r = await this._connectSendPC(toId, taskId, isRoom);
            // 无论直连成功还是降级 TURN 成功，都重置重试标记，
            // 否则多文件场景下第一个文件降级成功后，后续文件直连失败时无法再次降级 → 中途失败
            this._sendRetriedTurn = false;
            return r;
        } catch (e) {
            // 任何失败路径都先清理未成功的 PC/DC，避免连接泄漏、
            // 残留引用导致下一次传输错连旧连接（onWebrtcAnswer 用 this._sendPC 回设远端描述）
            if (this._sendPC) {
                try { this._sendPC.close(); } catch {}
                this._sendPC = null;
            }
            if (this._sendDC) {
                this._stopDcHeartbeat(this._sendDC);
                try { this._sendDC.close(); } catch {}
                this._sendDC = null;
            }
            // 本机无可打洞能力时第一次就用了完整列表，无需（也无法）降级
            if (this._lastConnectUsedFull) throw e;
            if (this._sendRetriedTurn) { this._sendRetriedTurn = false; throw e; }
            this._sendRetriedTurn = true;
            this._forceTurn = true;
            this.toast('直连尚未建立，尝试 TURN 中继兜底...', 'info');
            try {
                return await this._connectSendPC(toId, taskId, isRoom);
            } catch (e2) {
                this._sendRetriedTurn = false;
                throw e2;
            }
        }
    },

    // WebRTC P2P 发送
    async sendFileP2P(file, taskId, toId) {
        const { pc, dc } = await this._connectWithRetry(toId, taskId, false);
        try {
            // 发送文件元信息
            dc.send(JSON.stringify({ type: 'meta', name: file.name, size: file.size, mime: file.type }));

            // 分片发送文件（1MB/片，大分片减少调用开销）
            const chunkSize = 256 * 1024;
            const total = Math.ceil(file.size / chunkSize);
            const startTime = Date.now();
            let sent = 0;
            let lastProgressUpdate = 0;

            // 事件流控：高水位 8MB / 低水位 2MB
            // 高水位不能太高，否则会触发 "RTCDataChannel send queue is full"（浏览器内部限制约 16MB）
            const HIGH_WATERMARK = 8 * 1024 * 1024;
            const LOW_WATERMARK = 2 * 1024 * 1024;
            dc.bufferedAmountLowThreshold = LOW_WATERMARK;

            // 通用 buffer 等待：轮询 bufferedAmount + readyState，不再依赖 onbufferedamountlow 事件
            // （大文件传输中 DC 异常时该事件不触发，导致 30s 超时死等 → send buffer timeout）
            const waitForLow = (timeoutMs = 30000) => {
                const start = Date.now();
                let disconnectedSince = 0;
                return new Promise((resolve, reject) => {
                    const check = () => {
                        const cs = pc.connectionState;
                        if (dc.readyState === 'closed' || dc.readyState === 'closing') {
                            return reject(new Error('发送中断：连接已关闭'));
                        }
                        if (cs === 'failed') {
                            return reject(new Error('发送中断：ICE 连接失败'));
                        }
                        if (cs === 'disconnected') {
                            // 暂时断连（NAT 映射回收 / 中继链路抖动）：等 12s 恢复，超过则判定中断，
                            // 与接收端 10s 重连等待窗口协调，避免发送端死等 30s 后才发现，导致"传一半"无响应
                            if (!disconnectedSince) disconnectedSince = Date.now();
                            else if (Date.now() - disconnectedSince > 12000) {
                                return reject(new Error('发送中断：连接长时间断开'));
                            }
                        } else {
                            disconnectedSince = 0; // 已恢复 connected
                        }
                        if (dc.bufferedAmount <= LOW_WATERMARK) return resolve();
                        if (Date.now() - start > timeoutMs) return reject(new Error('send buffer timeout'));
                        setTimeout(check, 10);
                    };
                    check();
                });
            };
            const waitForBuffer = () => {
                if (dc.bufferedAmount < HIGH_WATERMARK) return Promise.resolve();
                return waitForLow();
            };

            // 预读第一片
            let nextBuf = file.slice(0, chunkSize).arrayBuffer();

            for (let i = 0; i < total; i++) {
                const buf = await nextBuf;
                // 预读下一片（不阻塞当前发送）
                if (i + 1 < total) {
                    const s = (i + 1) * chunkSize;
                    nextBuf = file.slice(s, Math.min(s + chunkSize, file.size)).arrayBuffer();
                }

                await waitForBuffer();
                try {
                    dc.send(buf);
                } catch {
                    // 缓冲区满，等降到低水位后重试（15s 超时兜底）
                    await waitForLow(15000);
                    dc.send(buf);
                }
                sent += buf.byteLength;

                // 节流更新进度（每 100ms）
                const now = Date.now();
                if (now - lastProgressUpdate > 100 || i === total - 1) {
                    lastProgressUpdate = now;
                    const pct = Math.round(sent / file.size * 100);
                    const speed = sent / ((now - startTime) / 1000 || 1);
                    this.updateProgress(sent, file.size, speed, pct);
                }
            }

            // 发送完成信号：先等缓冲降至低水位，确保 done 能进入发送队列
            // （缓冲满时 dc.send 会抛异常导致 done 丢失 → 接收端"收不完"）；短超时兜底，
            // 连接异常时 waitForLow 抛错由外层 try 捕获，走自动重连重传。
            try { await waitForLow(15000); } catch (e) { throw e; }
            dc.send(JSON.stringify({ type: 'done' }));

            // 等待接收端确认（done_ack）：收到即双方完成，此时才能安全关闭连接。
            // 慢速连接（TURN 中继）下最后一批分片 + done 可能仍在缓冲未发出，
            // 且接收端落盘（写磁盘 + IndexedDB）需要时间——若按旧逻辑 5s+3s 就关闭连接，
            // 会造成"发送端误报完成、接收端还在接收/落盘、随后报网络错误"。
            // 60s 超时兜底 + 连接断开/失败提前结束；未收到 ack 时明确提示未确认。
            const acked = await new Promise(resolve => {
                let settled = false;
                const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
                this._sendDoneAckResolve = () => done(true);
                const poll = () => {
                    if (settled) return;
                    if (dc.readyState === 'closed' || dc.readyState === 'closing' || pc.connectionState === 'failed') {
                        return done(false); // 连接已断开，无法收到确认
                    }
                    if (dc.bufferedAmount > 0) return setTimeout(poll, 20); // 数据仍在发出，继续等
                    setTimeout(poll, 50); // 缓冲区已清空，等接收端落盘后回 ack
                };
                poll();
                setTimeout(() => done(false), 60000);
            });
            this._sendDoneAckResolve = null;
            if (acked) {
                this.toast('对方已确认接收完成', 'success');
            } else {
                this.toast('发送完成，但未收到对方确认（请检查接收端文件是否完整）', 'info');
            }
        } finally {
            // 确保资源清理（即使异常也不泄漏）
            this._stopDcHeartbeat(dc);
            this._sendDoneAckResolve = null;
            try { dc.close(); } catch {}
            try { pc.close(); } catch {}
            this._sendPC = null;
            this._sendDC = null;
        }
    },

    onTransferAccept(payload) { const h = this._acceptHandlers.get(payload.taskId); if (h) h(); },
    onTransferReject(payload) { const h = this._rejectHandlers.get(payload.taskId); if (h) h(); },
    onTransferComplete(payload) { this.toast('对方已收到文件', 'success'); },

    // 对方取消了传输：关闭连接，更新状态，避免误判为连接异常
    onTransferCancel(payload) {
        console.log('[Transfer] 对方取消了传输:', payload?.taskId);
        // 若接收端仍停留在"接收确认框"（用户尚未点接受），必须一并关闭并清空 pendingReceive，
        // 否则确认框残留，用户点"接受"后仍进入"接收中"却永远等不到数据（发送端已取消）
        this.pendingReceive = null;
        this.$('receiveOverlay').classList.add('hidden');
        // 更新接收历史状态：取消时 _recvTaskId 可能尚未设置（确认框/等待 offer 阶段），
        // 直接用 payload.taskId 匹配，确保"接收中"状态被正确标记为失败
        const cancelTaskId = payload?.taskId;
        if (cancelTaskId) {
            const item = this.receiveHistory.find(i => i.taskId === cancelTaskId);
            if (item) { item.status = 'failed'; this.renderReceiveList(); }
        } else {
            this.updateReceiveStatus('failed');
        }
        this.closeProgress();
        this.cleanupAllTransfers();
        this.toast('对方已取消传输', 'info');
    },

    // 等待 ICE 收集完成（最多 5 秒）
    _waitIceComplete(pc) {
        return new Promise(resolve => {
            if (pc.iceGatheringState === 'complete') return resolve();
            const timer = setTimeout(() => resolve(), 5000);
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') {
                    clearTimeout(timer);
                    resolve();
                }
            };
        });
    },

    // 连接建立后通过 getStats 读取最终选定的 candidate-pair，判断实际通路类型。
    // 仅在跨网络（remote 作用域，即房间寻址）时提示；局域网直连属正常场景不打扰。
    async _analyzeConnection(pc, isCrossNetwork) {
        let pair = null;
        const candidates = new Map();
        try {
            const stats = await pc.getStats();
            stats.forEach(report => {
                if (report.type === 'candidate-pair') {
                    if (report.state === 'succeeded' && report.nominated) {
                        pair = report;
                    } else if (!pair && report.state === 'succeeded') {
                        pair = report;
                    }
                } else if (report.type === 'remote-candidate' || report.type === 'local-candidate') {
                    candidates.set(report.id, report);
                }
            });
        } catch (e) {
            return;
        }
        if (!pair) return;

        const local = candidates.get(pair.localCandidateId);
        const remote = candidates.get(pair.remoteCandidateId);
        const localType = local ? local.candidateType : '';
        const remoteType = remote ? remote.candidateType : '';
        const isRelay = localType === 'relay' || remoteType === 'relay';
        // 供 DC onopen 统一回写 Pill：走 TURN 时不能误显示"直连"
        this._lastViaTurn = isRelay;

        // 公网 IPv6（2000::/3）：排除链路本地( fe80 )/ ULA( fc00::/7 )/ 回环( ::1 )
        const isPublicV6 = (addr) => {
            if (!addr || !addr.includes(':')) return false;
            const a = String(addr).toLowerCase();
            if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd') || a === '::1') return false;
            return /^2[0-9a-f]/.test(a) || /^3[0-9a-f]/.test(a);
        };
        // 私网 IPv4（用于区分"局域网直连"与"公网 IPv4 直连"；含 CGNAT 共享地址）
        const isPrivateV4 = (addr) => {
            if (!addr || addr.includes(':')) return false;
            return addr.startsWith('10.') || addr.startsWith('192.168.') ||
                /^172\.(1[6-9]|2\d|3[0-1])\./.test(addr) || addr.startsWith('169.254.') ||
                addr.startsWith('100.64.'); // CGNAT 共享地址
        };
        const localIsPublicV6 = !!(local && isPublicV6(local.address));
        const remoteIsPublicV6 = !!(remote && isPublicV6(remote.address));

        if (!isCrossNetwork) return;

        if (isRelay) {
            // 走 TURN 中继：说明 host/srflx 直连未能建立，中继是兜底通路（用户自建）
            this.toast('已通过 TURN 中继连接（直连未建立）', 'info');
        } else if (localIsPublicV6 || remoteIsPublicV6) {
            // 选中 pair 任一方为公网 IPv6：host/srflx 均属 IPv6 直连，无需 NAT 打洞或 TURN
            this.toast('已通过公网 IPv6 直连', 'success');
        } else if (localType === 'srflx' || remoteType === 'srflx' || localType === 'prflx' || remoteType === 'prflx') {
            // srflx/prflx（IPv4）：STUN NAT 打洞直连成功，未走 TURN 中继
            this.toast('已通过 NAT 穿透直连', 'success');
        } else if (localType === 'host' && remoteType === 'host') {
            // host+host 非 relay 非 IPv6：双方公网 IPv4 直连，或房间内同局域网成员被标为跨网
            if (isPrivateV4(local.address) || isPrivateV4(remote.address)) {
                this.toast('已直连（局域网 host 直连）', 'success');
            } else {
                this.toast('已通过公网 IPv4 直连', 'success');
            }
        } else {
            // 连接已成功但通路类型未知：仅信息提示，不报错阻断
            console.warn('[analyze] 跨网络连接成功，但通路类型非预期:', { localType, remoteType });
            this.toast('跨网连接已建立（通路类型：' + (localType || '?') + '/' + (remoteType || '?') + '）', 'info');
        }
    },

    async _onConnectionState(pc, isCrossNetwork, role) {
        const state = pc.connectionState;
        if (state === 'connected') {
            // 通路类型分析与 _lastViaTurn 检测统一在 _analyzeConnection 内完成
            this._analyzeConnection(pc, isCrossNetwork);
            // 不在 ICE connected 阶段写 Pill —— DC 可能尚未打开，甚至信令已被 WS 断连阻断。
            // 真正成功时由 DataChannel onopen 或传输完成回调回写 setNetCapResult。
        } else if (state === 'failed') {
            if (isCrossNetwork) {
                // 精确诊断失败后给出可操作的提示，而非笼统的"不支持"
                this._diagnoseCrossNetworkFailure(pc);
                this.setNetCapResult(false, false);
            } else {
                this.toast('P2P 连接失败：网络受限', 'error');
            }
        }
    },

    // 跨网连接失败时的精确诊断：区分"无公网 IPv6"与"IPv6 入站被防火墙拦截"
    async _diagnoseCrossNetworkFailure(pc) {
        const isPublicV6 = (addr) => {
            if (!addr || !addr.includes(':')) return false;
            if (addr.startsWith('fe80') || addr.startsWith('fc') || addr.startsWith('fd') || addr.startsWith('::1')) return false;
            return /^2[0-9a-f]/i.test(addr) || /^3[0-9a-f]/i.test(addr);
        };
        let localHasPublicV6 = false, remoteHasPublicV6 = false, sawRelay = false;
        try {
            const stats = await pc.getStats();
            stats.forEach(r => {
                if ((r.type === 'local-candidate' || r.type === 'remote-candidate') && r.address) {
                    if (r.type === 'local-candidate' && isPublicV6(r.address)) localHasPublicV6 = true;
                    if (r.type === 'remote-candidate' && isPublicV6(r.address)) remoteHasPublicV6 = true;
                }
                // candidate 统计报告里没有 urls 字段（Chrome 用单数 url），
                // 探测结果 _natHasTurn 才是"是否配置 TURN"的可靠来源；relay 候选出现说明尝试过中继
                if (r.candidateType === 'relay') sawRelay = true;
            });
        } catch {}
        // 是否配置了 TURN（并尝试过）：配置了但失败 → TURN 中继不可用
        const hasTurn = !!this._natHasTurn || sawRelay;

        if (hasTurn) {
            this.toast('跨网连接失败：TURN 中继不可用，请检查 TURN_URLS 配置或网络', 'error');
        } else if (localHasPublicV6 && remoteHasPublicV6) {
            // 双方都有公网 IPv6 候选，但连通失败 → 几乎可以确定是 IPv6 入站被防火墙/安全组拦截
            this.toast('双方公网 IPv6 连通失败：IPv6 入站被防火墙拦截，建议配置 TURN 中继', 'error');
        } else {
            this.toast('跨网连接失败：需双方公网 IPv6 直连、STUN NAT 穿透（非对称 NAT）或配置 TURN 中继', 'error');
        }
    },

    // ===== WebRTC 信令处理（Trickle ICE：候选单独交换，降低握手延迟）=====
    async onWebrtcOffer(payload, isRoom = false, msgFromId = '') {
        // 清理旧的重连等待定时器（新 offer 到来意味着可以重试）
        if (this._reconnectWaitTimer) {
            clearTimeout(this._reconnectWaitTimer);
            this._reconnectWaitTimer = null;
        }
        // 清理直连失败后的 TURN 降级等待定时器（发送端已重建 offer，无需再等）
        if (this._recvDegradeTimer) {
            clearTimeout(this._recvDegradeTimer);
            this._recvDegradeTimer = null;
        }
        // 优先用 payload.fromId（后端已注入），兜底用顶层 msg.fromId
        const fromId = payload.fromId || msgFromId;
        const taskId = payload.taskId;
        // 若已有接收连接（上一次传输异常残留 / 对端重发 offer），先彻底关闭旧连接，
        // 否则新 offer 会被下面 _recvPC 守卫静默忽略，导致新连接永远连不上（表现为 connected 后很快 disconnected）
        if (this._recvPC) {
            // 先标记旧连接"已完成"以防止关闭时 onclose/onconnectionstatechange 回调弹出错误 toast
            this._recvDone = true;
            if (this._recvDC) { this._stopDcHeartbeat(this._recvDC); try { this._recvDC.close(); } catch {} }
            this._recvDC = null;
            clearTimeout(this._recvFinishTimer);
            // 清理文件句柄和可写流，避免残留文件句柄泄漏（旧连接文件不完整也需关闭）
            if (this._recvWritable) { try { this._recvWritable.close(); } catch {} this._recvWritable = null; }
            this._recvFileHandle = null;
            this._recvWriteReady = null;
            try { this._recvPC.close(); } catch {}
            this._recvPC = null;
        }
        this._recvDone = false;
        // 重置上一轮的接收状态：meta 到达前旧值残留会造成误判
        // （如新 DC 刚建立即断开时，dc.onclose 用旧 _recvSize/_recvTotal 误报"已收 N 字节未完成"）
        this._recvSize = 0;
        this._recvTotal = 0;
        this._recvBuffer = [];
        this._recvFlushSize = 0;
        this._recvFlushing = false;
        this._recvWriteInitInProgress = false;
        clearTimeout(this._recvFinishTimer);
        this._recvFinishTimer = null;
        this._recvChunkIndex = 0;
        this._recvPendingFinish = false;
        // 接收端始终使用完整列表（含 TURN）：中继需要双方都分配 relay 候选；
        // 发送端直连失败后降级重建 offer 时，本端已带 TURN，可正常建立中继。
        const iceCfg = await this._getIceServersForConnection(false);
        const pc = new RTCPeerConnection({ iceServers: iceCfg.servers });
        this._recvPC = pc;
        this._recvTaskId = taskId;
        // 候选缓存：trickle 候选可能早于 answer 到达，先缓存到 pc._candCache，
        // 待 setRemoteDescription 后由 onWebrtcCandidate 自动补加（与发送方一致，避免缓存两套丢失）
        pc._candCache = [];
        // 区分局域网直连(webrtc_*)与房间内传输(room_*)：对端在本房间设备列表中则走房间信令，否则走直连信令
        // 跨网(房间)判定：直接由信令类型决定（onMessage 已按 room_webrtc_offer / webrtc_offer 路由），
        // 不再依赖 payload.fromId（房间 offer 未携带 fromId，旧逻辑恒为 false 导致信令不匹配）
        const inRoom = !!isRoom;
        const candType = inRoom ? 'room_webrtc_candidate' : 'webrtc_candidate';
        const answerType = inRoom ? 'room_webrtc_answer' : 'webrtc_answer';

        // Trickle ICE：本端候选边收集边转发给对端
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.send({ type: candType, payload: { toId: fromId, taskId, candidate: e.candidate.toJSON() } });
            }
        };

        // 接收方：监听 DataChannel
        pc.ondatachannel = (e) => {
            const dc = e.channel;
            dc.binaryType = 'arraybuffer';
            dc.onopen = () => {
                this._startDcHeartbeat(dc);
                // 接收端同样按真实通路回写：_lastViaTurn 由 _analyzeConnection 检测，
                // 实际走 TURN 中继时不能误显示"直连"
                if (this._lastViaTurn !== undefined) this.setNetCapResult(true, this._lastViaTurn);
            };
            dc.onmessage = (event) => this.onDataChannelMessage(event.data);
            dc.onclose = () => {
                this._stopDcHeartbeat(dc);
                if (this._recvDone) { console.warn('[recvDC] 连接关闭（已完成），正常'); return; }
                if (this._recvSize > 0 && this._recvSize < this._recvTotal) {
                    // DC 关闭但数据不完整：启动 10s 重连等待，不立即报错
                    // 统一由 _reconnectWaitTimer 管理，允许 ICE 重连恢复
                    if (!this._reconnectWaitTimer) {
                        console.warn('[recvDC] DC 已关闭，等待 10s ICE 重连...');
                        this._reconnectWaitTimer = setTimeout(() => {
                            this._reconnectWaitTimer = null;
                            if (this._recvDone || (this._recvSize >= this._recvTotal)) return;
                            if (this._recvPC && this._recvPC.connectionState === 'connected') return;
                            this.toast('连接已断开，文件接收未完成', 'error');
                            this.releaseWakeLock();
                            this.updateReceiveStatus('failed');
                            this.closeProgress();
                        }, 10000);
                    }
                }
            };
            dc.onerror = (err) => {
                if (this._recvDone || (this._recvSize > 0 && this._recvSize >= this._recvTotal)) {
                    console.warn('[recvDC] 连接关闭（已接收完整），视为成功');
                    return;
                }
                // 远程主动断连（dc.close / pc.close）的三种信号：
                // 1. readyState 已变为 closed/closing（onclose 先于 onerror 触发）
                // 2. readyState 仍为 open 但错误消息为 "User-Initiated Abort"（onerror 先于状态变化）
                // 以上均非传输错误，按远程断连处理，设置 10s 重连等待
                const errMsg = (err && err.error && err.error.message) || '';
                const isUserAbort = errMsg.includes('User-Initiated Abort');
                if (dc.readyState === 'closed' || dc.readyState === 'closing' || isUserAbort) {
                    console.warn('[recvDC] error 但 DC 正在关闭（远程断连），忽略');
                    if (!this._reconnectWaitTimer && this._recvSize > 0 && this._recvSize < this._recvTotal) {
                        this._reconnectWaitTimer = setTimeout(() => {
                            this._reconnectWaitTimer = null;
                            if (this._recvDone || (this._recvSize >= this._recvTotal)) return;
                            if (this._recvPC && this._recvPC.connectionState === 'connected') return;
                            this.toast('连接已断开，文件接收未完成', 'error');
                            this.releaseWakeLock();
                            this.updateReceiveStatus('failed');
                            this.closeProgress();
                        }, 10000);
                    }
                    return;
                }
                // 若已有重连等待定时器，忽略 onerror（由定时器统一处理）
                if (this._reconnectWaitTimer) {
                    console.warn('[recvDC] error 但正在等待重连，忽略:', err?.message);
                    return;
                }
                console.error('[recvDC] error:', err);
                this.toast('数据通道出错，接收失败', 'error');
                this.updateReceiveStatus('failed');
                this.closeProgress();
            };
            this._recvDC = dc;
        };

        pc.onconnectionstatechange = (() => {
            let handled = false;
            return () => {
                const state = pc.connectionState;
                // 已被新 offer 替换 / 已清理的旧连接：忽略其所有状态回调，
                // 否则旧连接 close 触发的异步回调会因 _recvDone=false、_recvSize=0 而误报"未收到数据"
                if (this._recvPC !== pc) return;
                console.log('[recvPC] connectionState:', state);
                if (state === 'connected') {
                    this._analyzeConnection(pc, inRoom);
                    // 不在 ICE connected 写 Pill，等 DC onopen 或传输完成再回写
                } else if (state === 'failed') {
                    if (this._recvDone) { console.warn('[recvPC] PC failed 但传输已完成，正常'); return; }
                    if (!handled) {
                        handled = true;
                        // 无论是否带 TURN，首轮连接都可能失败于"发送端尚未拿到 relay pair"
                        // （发送端直连失败后正在降级 TURN 并重建 offer）。
                        // 静默等待新 offer（20s 超时），避免误报"跨网连接失败"。
                        console.warn('[recvPC] 连接失败，等待发送端降级/重试...');
                        clearTimeout(this._recvDegradeTimer);
                        this._recvDegradeTimer = setTimeout(() => {
                            if (this._recvDone || (this._recvPC && this._recvPC.connectionState === 'connected')) return;
                            this._onConnectionState(pc, inRoom, 'recv');
                        }, 20000);
                    }
                } else if (state === 'disconnected' && !handled) {
                    if (this._recvDone) { console.warn('[recvPC] 连接断开（已完成），正常'); return; }
                    // disconnected 是暂时性的（ICE 重连中），不立即报错，等待 10s
                    if (this._recvSize > 0 && this._recvSize < this._recvTotal) {
                        console.warn('[recvPC] 连接暂时断开，等待 ICE 重连...');
                        if (this._reconnectWaitTimer) clearTimeout(this._reconnectWaitTimer);
                        this._reconnectWaitTimer = setTimeout(() => {
                            this._reconnectWaitTimer = null;
                            if (this._recvDone || (this._recvSize >= this._recvTotal)) return;
                            if (this._recvPC && this._recvPC.connectionState === 'connected') return;
                            this.toast('连接已断开，文件接收未完成', 'error');
                            this.releaseWakeLock();
                            this.updateReceiveStatus('failed');
                            this.closeProgress();
                        }, 10000);
                    }
                } else if (state === 'closed' && !handled) {
                    if (this._recvDone) { return; }
                    if (this._recvSize > 0 && this._recvSize < this._recvTotal) {
                        this.toast('连接已关闭，文件接收未完成', 'error');
                        this.updateReceiveStatus('failed');
                        this.closeProgress();
                    } else if (this._recvSize === 0 && !this._recvDone) {
                        console.warn('[recvPC] 连接已关闭且未收到任何数据');
                        this.toast('连接已断开：未收到数据，可能 NAT 映射失效或被防火墙回收', 'error');
                    }
                }
            };
        })();

        // 设置远端 offer，创建并立即发送 answer（Trickle：候选后续单独补发）
        pc.setRemoteDescription(new RTCSessionDescription(payload.sdp)).then(() => {
            // 远端描述就绪，将 onWebrtcCandidate 缓存到 pc._candCache 的候选补加进去
            const pending = pc._candCache || [];
            pc._candCache = [];
            return Promise.all(pending.map(c => pc.addIceCandidate(c).catch(() => {})))
                .then(() => pc.createAnswer());
        }).then(answer => {
            return pc.setLocalDescription(answer);
        }).then(() => {
            // Trickle：立即发出 answer，不再等待 gathering complete
            this.send({ type: answerType, payload: { toId: fromId, sdp: pc.localDescription.toJSON() } });
        }).catch(err => {
            console.error('WebRTC offer 处理失败:', err);
            this.toast('连接建立失败', 'error');
        });
    },

    onWebrtcAnswer(payload) {
        if (this._sendPC) {
            this._sendPC.setRemoteDescription(new RTCSessionDescription(payload.sdp)).then(() => {
                // flush 缓存的候选
                const cache = this._sendPC._candCache || [];
                this._sendPC._candCache = [];
                cache.forEach(c => this._sendPC.addIceCandidate(c).catch(() => {}));
            }).catch(err => {
                console.error('WebRTC answer 设置失败:', err);
            });
        }
    },

    // ===== DataChannel 消息处理（接收方）=====
    onDataChannelMessage(data) {
        if (typeof data === 'string') {
            let msg;
            try { msg = JSON.parse(data); } catch { return; }
            if (msg.type === 'meta') {
                // 文件元信息
                this._recvBuffer = [];
                this._recvSize = 0;
                this._recvTotal = msg.size;
                this._recvName = msg.name;
                this._recvMime = msg.mime;
                this._recvStartTime = Date.now();
                this._recvWritable = null;
                this._recvChunkIndex = 0;
                this._recvFlushSize = 0;
                this._recvFlushing = false;
                this._recvPendingFinish = false;
                this._recvFinishTimer = null;

                // 如果有文件句柄，创建可写流（流式写盘）
                if (this._recvFileHandle) {
                    // createWritable 是异步的，用 _recvWriteReady 协调，避免 _finishReceive 关闭后句柄被覆盖。
                    // _recvWriteInitInProgress 防止 init 的 while 循环与 onDataChannelMessage 的 5MB flush
                    // 并发交换 _recvBuffer → init 循环提前看到空数组 → 磁盘文件丢失数据。
                    this._recvWriteInitInProgress = true;
                    this._recvWriteReady = this._recvFileHandle.createWritable().then(async w => {
                        // 先把 createWritable 期间缓冲的分片写入（保持顺序）
                        while (this._recvBuffer.length > 0) {
                            const buf = this._recvBuffer.shift();
                            await w.write(buf);
                        }
                        this._recvWriteInitInProgress = false;
                        this._recvWritable = w;
                        return w;
                    }).catch(() => { this._recvWriteInitInProgress = false; this._recvWritable = null; this._recvWriteReady = null; });
                } else {
                    this._recvWriteReady = null;
                }

                const item = this.receiveHistory.find(i => i.taskId === this._recvTaskId);
                if (item) { item.status = 'downloading'; item.fileSize = msg.size; this.renderReceiveList(); }

                this.openProgress(msg.name, '接收中');
                this.$('progressSize').textContent = `0 B / ${this.formatSize(msg.size)}`;
            } else if (msg.type === 'done') {
                this._recvDone = true;
                // 校验完整性：已收到的字节必须等于文件总大小，否则不能算完成。
                // 跨网传输时若最后几片/本消息本身乱序或丢失，_recvSize 会小于 _recvTotal，
                // 此时不能立即 finish，否则表现为“收不完”或写出不完整文件。
                if (this._recvSize >= this._recvTotal) {
                    // 数据完整：先落盘，_finishReceive 内部会在关闭连接前回发 done_ack
                    this._finishReceive();
                } else {
                    // 数据不完整：记录待完成，等剩余二进制到达补齐后再 finish。
                    this._recvPendingFinish = true;
                    const need = this._recvTotal - this._recvSize;
                    console.warn(`[recv] 收到 done 但数据不完整，已收 ${this._recvSize}/${this._recvTotal}，等待补齐 ${need} 字节`);
                    // 兜底：若 8 秒内仍补齐不全，按失败处理并提示真实原因。
                    // 不重置 _recvDone：保留该标记可抑制后续 close/failed 异步回调的误报 toast。
                    clearTimeout(this._recvFinishTimer);
                    this._recvFinishTimer = setTimeout(() => {
                        if (!this._recvDone || this._recvSize < this._recvTotal) {
                            this._recvPendingFinish = false;
                            console.error('[recv] 等待补齐超时，文件接收未完成');
                            this.toast(`接收未完成：缺少 ${this._recvTotal - this._recvSize} 字节（连接可能中断）`, 'error');
                            this.updateReceiveStatus('failed');
                            this.closeProgress();
                            // 超时后关闭连接，防止残留状态导致后续 close/failed 误弹错误
                            if (this._recvDC) { this._stopDcHeartbeat(this._recvDC); try { this._recvDC.close(); } catch {} this._recvDC = null; }
                            if (this._recvPC) { try { this._recvPC.close(); } catch {} this._recvPC = null; }
                            this.releaseWakeLock();
                        }
                    }, 8000);
                }
            } else if (msg.type === 'ping') {
                // 心跳包：忽略（仅用于保持跨网 NAT 映射）
                return;
            } else if (msg.type === 'done_ack') {
                // 发送端不会收到自己的 done_ack，这里用于防御性处理
                if (this._sendDoneAckResolve) {
                    this._sendDoneAckResolve();
                    this._sendDoneAckResolve = null;
                }
            }
        } else {
            // 二进制数据：文件分片
            this._recvSize += data.byteLength;

            // 优先写盘（不占内存），同时缓冲到 IndexedDB 分片确保刷新后可恢复
            if (this._recvWritable) {
                this._recvWritable.write(data);
            }
            // 统一走 IndexedDB 分片缓冲路径（桌面端和移动端都保留备份，刷新后可查看/下载）
            this._recvBuffer.push(data);
            this._recvFlushSize += data.byteLength;

            if (this._recvFlushSize >= 5 * 1024 * 1024 && !this._recvFlushing && !this._recvWriteInitInProgress) {
                const bufferToFlush = this._recvBuffer;
                this._recvBuffer = [];
                this._recvFlushSize = 0;
                const blob = new Blob(bufferToFlush, { type: this._recvMime || 'application/octet-stream' });
                // 必须 await 确保 IndexedDB 落盘完成，否则 done 到达时前面的分片可能未提交
                this._recvFlushing = this.dbPutChunk(this._recvTaskId, this._recvChunkIndex++, blob).then(() => {
                    this._recvFlushing = false;
                });
            }

            const pct = Math.round(this._recvSize / this._recvTotal * 100);
            const elapsed = (Date.now() - this._recvStartTime) / 1000 || 1;
            const speed = this._recvSize / elapsed;
            this.updateProgress(this._recvSize, this._recvTotal, speed, pct);

            // 若此前已收到 done 但数据不完整（跨网丢片），补齐后在此触发 finish
            if (this._recvPendingFinish && this._recvSize >= this._recvTotal) {
                this._recvPendingFinish = false;
                clearTimeout(this._recvFinishTimer);
                this._finishReceive();
            }
        }
    },

    async _finishReceive() {
        const item = this.receiveHistory.find(i => i.taskId === this._recvTaskId);
        // 立即释放 _recvPC / _recvDC 引用（不关闭连接），防止 _finishReceive 内的异步落盘
        // （await dbPutChunk / await writable.close 等）期间，发送端已发来下一文件 transfer_request，
        // onTransferRequest 的 _recvPC 守卫误判"仍在接收中"而自动拒绝。
        // 连接句柄保存到局部变量供 finally 关闭，_recvDC 在落盘成功后仍需发送 done_ack。
        const closingPC = this._recvPC;
        const closingDC = this._recvDC;
        this._recvPC = null;
        this._recvDC = null;
        try {
            // 图片/视频自动预览：单文件直接预览，多文件取第一个预览
            const isMedia = this.isImage(this._recvName) || this.isVideo(this._recvName);
            const shouldPreview = isMedia && ((this._recvFileTotal ?? 1) <= 1 || this._recvIndex === 0);

            if (this._recvWritable || this._recvWriteReady) {
                // 流式写盘模式（桌面端 Chrome/Edge）：等待可写流就绪并关闭，文件已保存到磁盘
                if (this._recvWriteReady) { try { await this._recvWriteReady; } catch {} }
                if (this._recvWritable) {
                    // 先把缓冲在内存的数据写入磁盘（createWritable 异步期间缓存的分片）
                    if (this._recvBuffer && this._recvBuffer.length > 0) {
                        for (const buf of this._recvBuffer) {
                            await this._recvWritable.write(buf);
                        }
                    }
                    await this._recvWritable.close();
                    this._recvWritable = null;
                }

                // 同时将剩余缓冲写入 IndexedDB 分片（确保刷新后可恢复查看/下载）
                if (this._recvFlushing) {
                    await this._recvFlushing;
                    this._recvFlushing = false;
                }
                if (this._recvBuffer.length > 0) {
                    const blob = new Blob(this._recvBuffer, { type: this._recvMime || 'application/octet-stream' });
                    await this.dbPutChunk(this._recvTaskId, this._recvChunkIndex++, blob);
                    this._recvBuffer = [];
                }

                if (item) { item.status = 'saved'; item.savedToDisk = true; this.renderReceiveList(); }

                // 保存元数据到 IndexedDB（chunkCount > 0 确保刷新后可从分片恢复）
                await this.dbPut({
                    taskId: this._recvTaskId,
                    fileName: this._recvName,
                    fileSize: this._recvTotal,
                    fromName: item?.fromName || '未知设备',
                    time: item?.time || new Date(),
                    mime: this._recvMime || 'application/octet-stream',
                    chunkCount: this._recvChunkIndex,
                    savedToDisk: true
                });

                this.closeProgress();

                // 自动预览：通过文件句柄获取 File 对象
                if (shouldPreview && this._recvFileHandle) {
                    try {
                        const file = await this._recvFileHandle.getFile();
                        const url = URL.createObjectURL(file);
                        if (item) { item.blobUrl = url; }
                        this.openPreviewBlob(url, this._recvName);
                    } catch { this.toast('文件已保存到磁盘', 'success'); }
                } else {
                    this.toast('文件已保存到磁盘', 'success');
                }
            } else {
                // 移动端：等待所有尚未完成的 flush（IndexedDB 异步写入可能尚未提交）
                if (this._recvFlushing) {
                    await this._recvFlushing;
                    this._recvFlushing = false;
                }
                // 写入剩余分片到 IndexedDB
                if (this._recvBuffer.length > 0) {
                    const blob = new Blob(this._recvBuffer, { type: this._recvMime || 'application/octet-stream' });
                    await this.dbPutChunk(this._recvTaskId, this._recvChunkIndex++, blob);
                    this._recvBuffer = [];
                }

                // 等待所有分片写入完成后，再记录元数据（确保刷新后能恢复）
                await this.dbPut({
                    taskId: this._recvTaskId,
                    fileName: this._recvName,
                    fileSize: this._recvTotal,
                    fromName: item?.fromName || '未知设备',
                    time: item?.time || new Date(),
                    mime: this._recvMime || 'application/octet-stream',
                    chunkCount: this._recvChunkIndex
                });

                if (item) { item.status = 'saved'; this.renderReceiveList(); }
                this.closeProgress();

                // 图片和视频自动弹出预览，其他文件显示 Toast
                if (shouldPreview) {
                    this.openPreviewFromDB(this._recvTaskId, this._recvName);
                } else if (isMedia && (this._recvFileTotal ?? 1) > 1) {
                    this.toast(`已接收 ${this._recvIndex + 1}/${this._recvFileTotal} 个文件`, 'success');
                } else {
                    this.toast('接收完成，点击「查看」可下载', 'success');
                }
            }

            this.send({ type: 'transfer_complete', payload: { taskId: this._recvTaskId, toId: item?.fromId } });

            // 落盘成功：在关闭连接前回发 done_ack，让发送端确认"接收完成"。
            // 必须在 finally 关闭 DC 之前发送——此前调用方在 _finishReceive().then() 里发 ack，
            // 但 finally 已先关闭 DC，ack 永远发不出去，导致发送端等不到确认而误报完成/提前断开。
            if (closingDC && closingDC.readyState === 'open') {
                try { closingDC.send(JSON.stringify({ type: 'done_ack' })); } catch {}
            }
        } catch (err) {
            console.error('[_finishReceive] 保存文件失败:', err);
            this.toast('文件保存失败，请重试', 'error');
            this.updateReceiveStatus('failed');
            this.closeProgress();
        } finally {
            // 清理（使用局部变量，_recvPC/_recvDC 已在开头置 null 解除 onTransferRequest 守卫）
            this._stopDcHeartbeat(closingDC);
            clearTimeout(this._recvFinishTimer);
            this._recvBuffer = [];
            if (this._recvWritable) { try { this._recvWritable.close(); } catch {} this._recvWritable = null; }
            this._recvWriteReady = null;
            if (closingDC) { try { closingDC.close(); } catch {} }
            this._recvFileHandle = null;
            if (closingPC) { try { closingPC.close(); } catch {} }
            this.releaseWakeLock();
        }
    },

    // DataChannel 心跳保活：跨网 NAT 映射在传输大文件（耗时数秒~数十秒）时可能被中间设备回收，
    // 导致连接 connected 后中途 disconnected、尾部数据（含 done）丢失 → “收不完”。
    // 周期性发送 ping（有序通道，不影响文件数据顺序），让 NAT 映射持续刷新，避免被回收。
    _startDcHeartbeat(dc) {
        this._stopDcHeartbeat(dc);
        dc._hbTimer = setInterval(() => {
            try { if (dc.readyState === 'open') dc.send(JSON.stringify({ type: 'ping' })); } catch {}
        }, 2000);
    },
    _stopDcHeartbeat(dc) {
        if (dc && dc._hbTimer) { clearInterval(dc._hbTimer); dc._hbTimer = null; }
    },

    updateReceiveStatus(status) {
        const item = this.receiveHistory.find(i => i.taskId === this._recvTaskId);
        if (item) {
            item.status = status;
            this.renderReceiveList();
        }
    },

    // ===== 接收请求 =====
    onTransferRequest(payload) {
        // 正在等待接收或正在接收中，自动拒绝新请求（避免 P2P 连接覆盖导致传输中断）
        if (this.pendingReceive || this._recvPC) {
            this.send({ type: 'transfer_reject', payload: { fromId: payload.fromId, taskId: payload.taskId } });
            return;
        }
        const dev = this.getTarget(payload.fromId);
        this.pendingReceive = {
            taskId: payload.taskId,
            fileName: payload.fileName,
            fileSize: payload.fileSize,
            fromId: payload.fromId,
            fromName: payload.fromName || dev?.name || '未知设备',
            index: typeof payload.index === 'number' ? payload.index : 0,
            total: typeof payload.total === 'number' ? payload.total : 1
        };
        this.$('recvFrom').textContent = this.pendingReceive.fromName;
        this.$('recvFileName').textContent = payload.fileName || 'file';
        this.$('recvFileSize').textContent = this.formatSize(payload.fileSize);
        this.$('receiveOverlay').classList.remove('hidden');
        if (this.mode !== 'recv') this.switchMode('recv');
    },

    async acceptReceive() {
        if (!this.pendingReceive) return;
        const { taskId, fromId, fileName, fileSize, fromName } = this.pendingReceive;

        // 如果浏览器支持 File System Access API，先弹出保存对话框（流式写盘，大文件不爆内存）
        this._recvFileHandle = null;
        if (window.showSaveFilePicker) {
            try {
                this._recvFileHandle = await window.showSaveFilePicker({
                    suggestedName: fileName || 'file',
                });
            } catch (e) {
                // 用户取消或不支持，回退到内存 Blob
                this._recvFileHandle = null;
            }
        }

        this.send({ type: 'transfer_accept', payload: { fromId, taskId } });
        this.$('receiveOverlay').classList.add('hidden');
        this.requestWakeLock();  // 接收期间保持屏幕常亮
        this._recvFileTotal = this.pendingReceive.total; // 本次发送的总文件数（与 _recvTotal=文件字节数区分）
        this._recvIndex = this.pendingReceive.index;
        this.receiveHistory.unshift({ taskId, fileName, fileSize, fromName, fromId, time: new Date(), status: 'waiting' });
        this.pendingReceive = null;
        this.renderReceiveList();
    },

    rejectReceive() {
        if (!this.pendingReceive) return;
        const { taskId, fromId } = this.pendingReceive;
        this.send({ type: 'transfer_reject', payload: { fromId, taskId } });
        this.$('receiveOverlay').classList.add('hidden');
        this.pendingReceive = null;
    },

    // ===== 文件类型判断 =====
    isImage(name) { return /\.(jpg|jpeg|png|gif|webp|bmp|svg|heic|heif)$/i.test(name || ''); },
    isVideo(name) { return /\.(mp4|mov|avi|mkv|webm|m4v|3gp)$/i.test(name || ''); },
    isHeic(name) { return /\.(heic|heif|heics)$/i.test(name || ''); },

    // 根据文件扩展名推断 MIME type（安卓需要正确 MIME type 才能保存到相册）
    getMimeFromFileName(name) {
        const ext = (name || '').toLowerCase().match(/\.([^.]+)$/);
        if (!ext) return '';
        const map = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
            webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
            heic: 'image/heic', heif: 'image/heif',
            mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
            mkv: 'video/x-matroska', webm: 'video/webm', m4v: 'video/x-m4v', '3gp': 'video/3gpp',
        };
        return map[ext[1]] || '';
    },

    // 可靠下载：现代 Chrome 直接 a[download]；WebView/非 Chrome 通过 fetch 重建 blob 下载
    async _downloadBlob(url, fileName) {
        // 现代 Chrome（非 WebView）：直接 a[download] 可行，无需 fetch 开销
        if (navigator.userAgent.includes('Chrome') && !/WVMobile|WebView/i.test(navigator.userAgent)) {
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName || '';
            document.body.appendChild(a);
            a.click();
            a.remove();
            return;
        }
        // 其他浏览器（WebView / 鸿蒙 / 非 Chrome 内核）：fetch 重建 blob 确保兼容
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            const downloadUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = fileName || '';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);
        } catch {
            // 降级：直接使用原始 blob URL
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName || '';
            document.body.appendChild(a);
            a.click();
            a.remove();
        }
    },

    // ===== 下载已接收的文件 =====
    async startDownload(taskId, fileName) {
        const item = this.receiveHistory.find(i => i.taskId === taskId);
        if (!item) return;

        if (item.savedToDisk && !item.chunkCount) {
            // 文件已通过 File System Access API 保存到磁盘，且无 IndexedDB 备份
            this.toast('文件已保存到磁盘', 'info');
            return;
        }

        // 优先用内存 URL（当前会话）
        if (item.blobUrl) {
            if (this.isImage(fileName) || this.isVideo(fileName)) {
                this.openPreviewBlob(item.blobUrl, fileName);
            } else {
                await this._downloadBlob(item.blobUrl, fileName || '');
            }
            return;
        }

        // 刷新后从 IndexedDB 分片恢复（含桌面端流式写盘的 IndexedDB 备份）
        await this.openPreviewFromDB(taskId, fileName, true);
    },

    // 从 IndexedDB 分片恢复文件，打开预览或下载
    async openPreviewFromDB(taskId, fileName, autoDownloadForNonMedia) {
        const record = await this.dbGet(taskId);
        if (!record) {
            this.toast('文件不可用', 'error');
            return;
        }

        // 读取所有分片合并为 Blob
        const chunks = await this.dbGetChunks(taskId);
        if (chunks.length === 0) {
            this.toast('文件不可用', 'error');
            return;
        }

        const blob = new Blob(chunks, { type: record.mime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);

        // 缓存到内存
        const item = this.receiveHistory.find(i => i.taskId === taskId);
        if (item) { item.blobUrl = url; }

        if (this.isImage(fileName) || this.isVideo(fileName)) {
            this.openPreviewBlob(url, fileName);
        } else if (autoDownloadForNonMedia) {
            await this._downloadBlob(url, fileName || '');
        }
    },

    // ===== 媒体预览（基于 Blob URL）=====
    openPreviewBlob(blobUrl, fileName) {
        this.previewBlobUrl = blobUrl;
        this.previewFileName = fileName;
        const content = this.$('previewContent');
        if (this.isImage(fileName)) {
            if (this.isHeic(fileName)) {
                // HEIC 格式：Safari 原生支持，Chrome/Firefox 不支持
                // 加载失败时显示提示，仍可下载
                content.innerHTML = `<img src="${blobUrl}" alt="${this.escape(fileName)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="preview-unsupported" style="display:none"><p>HEIC 格式不支持浏览器预览</p><span>请点击「保存到相册」下载后查看</span></div>`;
            } else {
                content.innerHTML = `<img src="${blobUrl}" alt="${this.escape(fileName)}">`;
            }
        } else {
            content.innerHTML = `<video src="${blobUrl}" controls playsinline></video>`;
        }
        this.$('previewName').textContent = fileName;
        this.currentPreviewEl = content.querySelector('img, video');
        this.$('previewOverlay').classList.remove('hidden');
    },
    closePreview() {
        const content = this.$('previewContent');
        const video = content.querySelector('video');
        if (video) video.pause();
        content.innerHTML = '';
        this.currentPreviewEl = null;
        this.$('previewOverlay').classList.add('hidden');
        this.previewBlobUrl = null;
    },

    // 保存到相册
    // Web 平台无法直接写入系统相册，唯一可靠路径是 navigator.share 调起系统分享面板，
    // 由用户选择「添加到照片/存储到相册」。HTTPS 环境下 iOS/安卓均可使用 share。
    async saveMedia() {
        if (!this.previewBlobUrl) return;
        const fileName = this.previewFileName || 'file';
        const btn = this.$('previewSave');
        const isImg = this.isImage(fileName);
        const isVid = this.isVideo(fileName);

        try {
            btn.textContent = '加载中…';
            btn.disabled = true;

            // 获取 blob 数据
            const res = await fetch(this.previewBlobUrl);
            let blob = await res.blob();

            // 图片：仅对 iOS 分享有风险的格式（heic/heif/webp）做 canvas 转码为 jpeg，
            // 其余格式（jpeg/png）直接复用原 blob，避免透明度丢失与二次画质损失。
            let shareBlob = blob;
            let shareName = fileName;
            const lowerName = fileName.toLowerCase();
            const needTranscode = /\.(heic|heif|webp)$/.test(lowerName) || blob.type === 'image/heic' || blob.type === 'image/heif' || blob.type === 'image/webp';
            if (isImg && needTranscode) {
                try {
                    const img = new Image();
                    await new Promise((resolve, reject) => {
                        img.onload = resolve; img.onerror = reject;
                        img.src = URL.createObjectURL(blob);
                    });
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    canvas.getContext('2d').drawImage(img, 0, 0);
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
                    shareBlob = await (await fetch(dataUrl)).blob();
                    shareName = fileName.replace(/\.[^.]+$/, '') + '.jpg';
                    URL.revokeObjectURL(img.src);
                } catch (e) {
                    // 转码失败（如无法解码）则退回原 blob
                    shareBlob = blob; shareName = fileName;
                }
            } else if (!isImg) {
                // 视频/其他：根据扩展名修正 MIME（安卓需正确 MIME 才能存相册）
                const correctMime = this.getMimeFromFileName(fileName);
                if (correctMime && blob.type !== correctMime) {
                    shareBlob = new Blob([blob], { type: correctMime });
                    shareName = fileName;
                }
            }

            // 方案1：Web Share API 调起系统分享面板（含「保存到相册」选项）
            const file = new File([shareBlob], shareName, { type: shareBlob.type || 'application/octet-stream' });
            const canShare = navigator.canShare && navigator.canShare({ files: [file] });
            if (navigator.share && (canShare || isImg)) {
                try {
                    await navigator.share({ files: [file], title: shareName });
                    this.toast('请在系统面板选择「添加到照片 / 存储到相册」', 'success');
                    return;
                } catch (e) {
                    // 用户取消或分享失败，继续兜底
                }
            }

            // 方案2：降级下载。现代 Chrome 直接 a[download]；非 Chrome 由 _downloadBlob 做 fetch 兼容
            const downloadUrl = URL.createObjectURL(shareBlob);
            await this._downloadBlob(downloadUrl, shareName);
            URL.revokeObjectURL(downloadUrl);

            if (isImg) {
                this.toast('已下载：安卓可在相册/下载查看；iOS 请在「文件」中长按存储', 'info');
            } else if (isVid) {
                this.toast('已下载：请在系统相册/下载中查看；iOS 需在「文件」中长按保存', 'info');
            } else {
                this.toast('已下载', 'info');
            }
        } catch (err) {
            // 方案3：极端环境（如微信）不支持下载/分享，引导长按保存
            const el = this.currentPreviewEl;
            if (el) {
                try { el.setAttribute('controls', 'controls'); } catch (e) {}
                const sel = window.getSelection();
                if (sel) { sel.removeAllRanges(); const r = document.createRange(); r.selectNode(el); sel.addRange(r); }
            }
            this.toast('当前环境无法自动保存，请长按图片/视频选择「存储到相册」', 'info');
        } finally {
            btn.textContent = '保存到相册';
            btn.disabled = false;
        }
    },

    // ===== 接收列表 =====
    renderReceiveList() {
        const list = this.$('receiveList');
        const empty = this.$('emptyReceive');
        const cb = this.$('clearHistoryBtn');
        if (this.receiveHistory.length === 0) {
            list.innerHTML = ''; empty.classList.remove('hidden'); cb.classList.add('hidden'); return;
        }
        empty.classList.add('hidden'); cb.classList.remove('hidden');
        list.innerHTML = this.receiveHistory.map(item => {
            let st = '等待中', cls = 'waiting', action = '';
            if (item.status === 'downloading') { st = '接收中'; cls = 'downloading'; }
            else if (item.status === 'saved') {
                st = '已保存'; cls = 'saved';
                // 磁盘已保存的文件：若有 IndexedDB 分片备份（chunkCount > 0），仍可刷新后查看/下载
                if (!item.savedToDisk || item.chunkCount > 0) {
                    action = this.isImage(item.fileName) || this.isVideo(item.fileName) ? '查看' : '下载';
                }
            }
            return `
                <div class="recv-item">
                    <div class="recv-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></div>
                    <div class="recv-item-info">
                        <div class="recv-item-name">${this.escape(item.fileName)}</div>
                        <div class="recv-item-meta">
                            <span>${this.escape(item.fromName)}</span>
                            <span>·</span>
                            <span>${this.formatSize(item.fileSize)}</span>
                            <span>·</span>
                            <span>${this.formatTime(item.time)}</span>
                        </div>
                    </div>
                    ${action
                        ? `<button class="recv-item-action" data-task="${item.taskId}" data-name="${this.escape(item.fileName)}" data-size="${item.fileSize}">${action}</button>`
                        : `<span class="recv-item-status ${cls}">${st}</span>`}
                </div>`;
        }).join('');
        list.querySelectorAll('.recv-item-action').forEach(btn => {
            btn.addEventListener('click', () => this.startDownload(btn.dataset.task, btn.dataset.name));
        });
    },

    async clearHistory() {
        // 释放内存 URL
        this.receiveHistory.forEach(item => {
            if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
        });
        await this.dbClear();
        this.receiveHistory = [];
        this.renderReceiveList();
    },

    // ===== 进度弹窗 =====
    openProgress(name, status) {
        // 新的传输开始时，清掉上一次"完成"自动关闭定时器
        if (this._doneAutoCloseTimer) {
            clearTimeout(this._doneAutoCloseTimer);
            this._doneAutoCloseTimer = null;
        }
        this.$('progressName').textContent = name;
        this.$('progressStatus').textContent = status || '传输中';
        this.$('progressStatus').classList.remove('done');
        this.$('progressFill').style.width = '0%';
        this.$('progressSize').textContent = '0 B / 0 B';
        this.$('progressSpeed').textContent = '-';
        this.$('progressDone').classList.add('hidden');
        this.$('progressCancel').classList.remove('hidden');
        this.$('progressOverlay').classList.remove('hidden');
    },
    updateProgress(cur, total, speed, pct) {
        this.$('progressFill').style.width = pct + '%';
        this.$('progressSize').textContent = `${this.formatSize(cur)} / ${this.formatSize(total)}`;
        this.$('progressSpeed').textContent = speed > 0 ? `${this.formatSize(speed)}/s` : '—';
    },
    showProgressDone() {
        // 传输成功兜底回写网络能力提示：若 dc.onopen 早于 ICE connected 导致
        // _lastViaTurn 未设置，Pill 会停留在预测文本，这里统一按最终成功回写
        if (this._lastViaTurn !== undefined) this.setNetCapResult(true, this._lastViaTurn === true);
        this.$('progressStatus').textContent = '完成';
        this.$('progressStatus').classList.add('done');
        this.$('progressFill').style.width = '100%';
        this.$('progressDone').classList.remove('hidden');
        this.$('progressCancel').classList.add('hidden');
        // 自动关闭弹窗：1.5s 后只有仍处于完成态时才关闭（多文件场景下会被下一轮 openProgress 取消）
        if (this._doneAutoCloseTimer) clearTimeout(this._doneAutoCloseTimer);
        this._doneAutoCloseTimer = setTimeout(() => {
            this._doneAutoCloseTimer = null;
            if (this.$('progressStatus')?.classList.contains('done')) {
                this.closeProgress();
            }
        }, 1500);
    },
    closeProgress() {
        if (this._reconnectWaitTimer) {
            clearTimeout(this._reconnectWaitTimer);
            this._reconnectWaitTimer = null;
        }
        if (this._doneAutoCloseTimer) {
            clearTimeout(this._doneAutoCloseTimer);
            this._doneAutoCloseTimer = null;
        }
        this.$('progressOverlay').classList.add('hidden');
        this.$('progressStatus').classList.remove('done');
        this.$('progressCancel').classList.add('hidden');
    },

    // Screen Wake Lock：传输期间保持屏幕常亮，避免手机自动锁屏中断传输
    async requestWakeLock() {
        if (!('wakeLock' in navigator)) return;
        try {
            // 先释放已有锁（避免重复请求报错）
            await this.releaseWakeLock();
            this._wakeLock = await navigator.wakeLock.request('screen');
            this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
        } catch {
            // 用户切换 App / 锁屏 / 浏览器不支持时静默失败，不影响传输
        }
    },
    async releaseWakeLock() {
        if (this._wakeLock) {
            try { await this._wakeLock.release(); } catch {}
            this._wakeLock = null;
        }
    },

    // 取消当前传输：关闭 WebRTC 连接，通知对端，清理状态
    cancelTransfer() {
        const taskId = this._sendTaskId || this._recvTaskId;
        // 通知对端取消传输（需在关闭连接前发送）
        if (taskId) {
            const toId = this.selectedTarget || (this.pendingReceive?.fromId);
            if (toId) {
                this.send({ type: 'transfer_cancel', payload: { taskId, toId } });
            }
        }
        // 本端主动取消标记：startSend 循环/重传据此立即停止，
        // 避免取消后 sendFileP2P 因连接被关闭抛出"连接中断"错误而再次触发自动重传
        this._sendCancelled = true;
        // 立即结束等待中的 accept（resolve 'cancelled'），否则 waitForAccept 会悬挂到 60s 超时
        this._acceptWaiters.forEach(resolve => resolve('cancelled'));
        this._acceptWaiters.clear();
        this._acceptHandlers.clear();
        this._rejectHandlers.clear();
        // 更新接收状态为失败
        this.updateReceiveStatus('failed');
        // 关闭进度弹窗
        this.closeProgress();
        // 统一清理所有传输资源
        this.cleanupAllTransfers();
        this.toast('已取消传输', 'info');
    },

    // 传输完成后统一清理：释放所有 P2P 资源，重置状态，确保下次传输从干净状态开始
    cleanupAllTransfers() {
        // 清理重连等待定时器
        if (this._reconnectWaitTimer) {
            clearTimeout(this._reconnectWaitTimer);
            this._reconnectWaitTimer = null;
        }
        // 清理接收端 TURN 降级等待定时器（取消后残留会在 20s 后误报"连接失败"）
        if (this._recvDegradeTimer) {
            clearTimeout(this._recvDegradeTimer);
            this._recvDegradeTimer = null;
        }
        // 清理进度弹窗自动关闭定时器
        if (this._doneAutoCloseTimer) {
            clearTimeout(this._doneAutoCloseTimer);
            this._doneAutoCloseTimer = null;
        }
        // 关闭发送端（先停心跳再关连接）
        if (this._sendDC) { this._stopDcHeartbeat(this._sendDC); try { this._sendDC.close(); } catch {} this._sendDC = null; }
        if (this._sendPC) { try { this._sendPC.close(); } catch {} this._sendPC = null; }
        this._sendTaskId = null;
        this._sendDoneAckResolve = null;
        // 清理等待 accept 的悬挂 Promise 与取消标记（防止残留状态影响下一次传输）
        this._acceptWaiters.clear();
        this._acceptHandlers.clear();
        this._rejectHandlers.clear();
        // 注意：_sendCancelled 不在此重置——cancelTransfer 置位后 waitForAccept 立即
        // resolve('cancelled') 回到 startSend 循环，cleanupAllTransfers 紧随其后重置此标记
        // 会导致 startSend 检查 _sendCancelled 时已为 false，取消检测失效。
        // 关闭接收端（先停心跳再关连接）
        if (this._recvDC) { this._stopDcHeartbeat(this._recvDC); try { this._recvDC.close(); } catch {} this._recvDC = null; }
        if (this._recvPC) { try { this._recvPC.close(); } catch {} this._recvPC = null; }
        this._recvTaskId = null;
        // 清理接收缓冲和文件句柄
        clearTimeout(this._recvFinishTimer);
        this._recvFinishTimer = null;
        this._recvPendingFinish = false;
        this._recvBuffer = [];
        this._recvFlushing = false;
        this._recvFlushSize = 0;
        this._recvWriteInitInProgress = false;
        if (this._recvWritable) { try { this._recvWritable.close(); } catch {} this._recvWritable = null; }
        this._recvWriteReady = null;
        this._recvFileHandle = null;
        // 重置发送端 TURN 降级/直连重试标记，避免残留状态污染下一次传输
        this._sendRetriedTurn = false;
        this._forceTurn = false;
        // 重置网络能力探测结果
        this._lastViaTurn = undefined;
        this._lastNetCapResult = undefined;
        // 重置接收完成标记
        this._recvDone = false;
        this._recvPendingFinish = false;
        clearTimeout(this._recvFinishTimer);
        this._recvFinishTimer = null;
        // 重置发送状态
        this.activeUpload = false;
        this.clearFiles();
        this.selectedTarget = null;
        this._updateNetCapPill('unknown');
        // 释放屏幕常亮
        this.releaseWakeLock();
    },

    // ===== 状态 =====
    updateStatus(state) {
        const el = this.$('status');
        el.className = 'status ' + state;
        const textMap = {
            'connected': '已连接',
            'connecting': '连接中...',
            'error': '连接错误'
        };
        const textEl = this.$('statusText');
        textEl.textContent = textMap[state] || state;
    },

    // ===== 工具 =====
    formatSize(b) {
        if (!b) return '0 B';
        const k = 1024, u = ['B','KB','MB','GB','TB'];
        const i = Math.floor(Math.log(b) / Math.log(k));
        return (b / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
    },
    formatTime(d) {
        if (!d) return '';
        const diff = Date.now() - new Date(d);
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff / 60000) + '分前';
        if (diff < 86400000) return Math.floor(diff / 3600000) + '时前';
        return new Date(d).toLocaleDateString('zh-CN');
    },
    escape(t) {
        if (t == null) return '';
        const d = document.createElement('div');
        d.textContent = String(t);
        return d.innerHTML;
    },
    // 复制页面链接分享给同局域网用户
    copyShareUrl() {
        const btn = this.$('copyUrlBtn');
        try {
            const text = `千盈传送 - 打开下面的链接，同一 WiFi 下浏览器互传文件\n${location.href}`;
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.top = '-9999px';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            btn.classList.add('copied');
            this.toast('链接已复制，粘贴发送给小伙伴吧', 'success');
            setTimeout(() => btn.classList.remove('copied'), 2000);
        } catch (e) {
            this.toast('复制失败，请手动复制地址栏链接', 'error');
        }
    },
    // 复制当前页面链接（微信提示用，兼容 HTTP 与微信内置 WebView）
    copyLink() {
        const btn = this.$('wechatCopyBtn');
        try {
            const ta = document.createElement('textarea');
            ta.value = location.href;
            ta.style.position = 'fixed';
            ta.style.top = '-9999px';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            btn.textContent = '已复制链接 ✓';
            setTimeout(() => { btn.textContent = '复制链接到浏览器打开'; }, 2000);
        } catch (e) {
            this.toast('复制失败，请手动复制地址栏链接', 'error');
        }
    },
    // ===== 文件大小超限浮窗 =====
    showSizeLimitAlert(files) {
        const maxSize = this._maxFileSizeMB * 1024 * 1024;
        const names = files.map(f => `${this.escape(f.name)} <span style="color:var(--text-3)">${this.formatSize(f.size)}</span>`).join(', ');
        this.$('sizeLimitFiles').innerHTML = names;
        this.$('sizeLimitMax').textContent = this.formatSize(maxSize);
        this.$('sizeLimitOverlay').classList.remove('hidden');
    },

    toast(msg, type = 'info') {
        const c = this.$('toastContainer');
        const t = document.createElement('div');
        t.className = 'toast ' + type;
        t.innerHTML = `<span class="toast-dot"></span><span>${this.escape(msg)}</span>`;
        c.appendChild(t);
        setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 150); }, 2800);
    },

    // 居中浮窗提醒（z-index 高于 overlay，发送/接收关键节点给用户明确反馈）
    centerToast(msg, type = 'info') {
        let ct = document.getElementById('centerToast');
        if (!ct) {
            ct = document.createElement('div');
            ct.id = 'centerToast';
            document.body.appendChild(ct);
        }
        ct.textContent = msg;
        ct.className = 'center-toast center-toast-' + type + ' center-toast-show';
        clearTimeout(this._centerToastTimer);
        this._centerToastTimer = setTimeout(() => {
            ct.classList.remove('center-toast-show');
        }, 2500);
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());