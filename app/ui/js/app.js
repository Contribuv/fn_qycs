// ===== 传送 =====

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
    _idb: null,
    _dbReady: null,

    $: (id) => document.getElementById(id),

    init() {
        this.userTheme = localStorage.getItem('yuanbaba_theme') || 'auto';
        this.deviceName = localStorage.getItem('yuanbaba_name') || '';
        this.mode = localStorage.getItem('yuanbaba_mode') || 'send';
        this._everConnected = false;  // 用于判断是否局域网被拒
        // 微信浏览器检测：仅允许发送，接收 tab 显示不支持提示
        this.isWechat = /micromessenger/i.test(navigator.userAgent);
        if (this.isWechat && this.mode === 'recv') this.mode = 'send';
        this.applyTheme();
        this.bindEvents();
        this.connect();
        this.loadHistory();
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
        // 检测是否为内网 IPv4
        if (/^(127\.|^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.)/.test(ip)) {
            return ip;
        }
        // 纯 IPv4 也显示
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
            return ip;
        }
        // IPv6 不显示（太长了没意义）
        return '';
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
                blobUrl: null
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
        document.querySelectorAll('.theme-opt').forEach(btn => {
            btn.addEventListener('click', () => this.setTheme(btn.dataset.theme));
        });

        // 关于
        this.$('openAbout').addEventListener('click', () => { this.closeSettings(); this.openAbout(); });
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

        // 预览弹窗
        this.$('previewClose').addEventListener('click', () => this.closePreview());
        this.$('previewOverlay').addEventListener('click', (e) => {
            if (e.target === this.$('previewOverlay')) this.closePreview();
        });
        this.$('previewSave').addEventListener('click', () => this.saveMedia());

        // 微信提示：复制链接到系统浏览器打开
        this.$('wechatCopyBtn').addEventListener('click', () => this.copyLink());
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

    // 微信浏览器在接收 tab 显示不支持提示，隐藏正常接收内容
    updateRecvNotice() {
        const notice = this.$('wechatNotice');
        if (!notice) return;
        const showNotice = this.isWechat && this.mode === 'recv';
        notice.classList.toggle('hidden', !showNotice);
        this.$('recvHero').classList.toggle('hidden', showNotice);
        this.$('recvPanel').querySelector('.section').classList.toggle('hidden', showNotice);
    },

    // ===== WebSocket =====
    connect() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        // 统一网关路径: 从当前页面路径推导基路径（兼容 /app/fn_qycs/gateway 和 /）
        const basePath = location.pathname.replace(/\/[^/]*$/, '');
        let url = `${proto}//${location.host}${basePath}/ws`;
        if (this.deviceName) url += '?name=' + encodeURIComponent(this.deviceName);
        this.updateStatus('connecting');
        this.ws = new WebSocket(url);
        this._lanOnly = false; // 重置局域网限制标记
        this.ws.onopen = () => {
            this._everConnected = true;
            this.updateStatus('connected');
            this.startHeartbeat();
        };
        this.ws.onmessage = (e) => {
            // 检测服务端返回的局域网限制消息
            try {
                const msg = JSON.parse(e.data);
                if (msg.code === 'lan_only') {
                    this._lanOnly = true;
                    this.updateStatus('lan_only');
                    this.stopHeartbeat();
                    this.ws.close();
                    return;
                }
            } catch (err) {}
            try { this.onMessage(JSON.parse(e.data)); }
            catch (err) { console.error('[WS] 消息处理错误:', err, e.data?.substring(0, 200)); }
        };
        this.ws.onclose = (e) => {
            // 如果收到过局域网限制消息，不再重连
            if (this._lanOnly) {
                this.updateStatus('lan_only');
                return;
            }
            this.updateStatus('error');
            this.stopHeartbeat();
            this.scheduleReconnect();
        };
        this.ws.onerror = () => {};
    },
    scheduleReconnect() {
        if (this.reconnectTimer) return;
        if (this._lanOnly) return; // 局域网限制时不重连
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
        }, 10000);
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
    send(msg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); },

    onMessage(msg) {
        switch (msg.type) {
            case 'welcome': this.onWelcome(msg.payload); break;
            case 'device_list': this.onDeviceList(msg.payload); break;
            case 'device_online': this.onDeviceOnline(msg.payload); break;
            case 'device_offline': this.onDeviceOffline(msg.payload); break;
            case 'device_name_updated': this.onDeviceNameUpdated(msg.payload); break;
            case 'transfer_request': this.onTransferRequest(msg.payload); break;
            case 'transfer_accept': this.onTransferAccept(msg.payload); break;
            case 'transfer_reject': this.onTransferReject(msg.payload); break;
            case 'transfer_complete': this.onTransferComplete(msg.payload); break;
            // WebRTC P2P 信令
            case 'webrtc_offer': this.onWebrtcOffer(msg.payload); break;
            case 'webrtc_answer': this.onWebrtcAnswer(msg.payload); break;
        }
    },

    // ===== WS 事件处理 =====
    onWelcome(payload) {
        this.deviceId = payload.deviceId;
        if (payload.device?.name) {
            this.deviceName = payload.device.name;
            localStorage.setItem('yuanbaba_name', this.deviceName);
        }
        this.$('selfName').textContent = this.deviceName || '未命名';
    },

    onDeviceList(devices) {
        const list = devices || [];
        console.log('[WS] 收到设备列表:', list.length, '台, 我的ID:', this.deviceId?.substring(0, 10), '设备IDs:', list.map(d => d.id?.substring(0, 10)));
        // 合并而非清空：避免设备闪烁，同时去掉已不存在的设备
        const newIds = new Set();
        list.forEach(d => {
            if (d.id !== this.deviceId) {
                newIds.add(d.id);
                this.devices.set(d.id, d);
            }
        });
        // 删除已不存在的设备
        for (const id of this.devices.keys()) {
            if (!newIds.has(id)) this.devices.delete(id);
        }
        this.renderDevices();
    },

    onDeviceOnline(device) {
        console.log('[WS] 设备上线:', device.name, device.id?.substring(0, 10), '我的ID:', this.deviceId?.substring(0, 10));
        if (device.id === this.deviceId) return;
        const isNew = !this.devices.has(device.id);
        this.devices.set(device.id, device);
        this.renderDevices();
        if (isNew) this.toast(`${device.name} 已加入`, 'info');
    },

    onDeviceOffline(payload) {
        const dev = this.devices.get(payload.deviceId);
        this.devices.delete(payload.deviceId);
        if (this.selectedTarget === payload.deviceId) { this.selectedTarget = null; this.updateSendBar(); }
        this.renderDevices();
        if (dev) this.toast(`${dev.name} 已离开`, 'info');
    },

    onDeviceNameUpdated(payload) {
        const dev = this.devices.get(payload.deviceId);
        if (dev) { dev.name = payload.name; this.renderDevices(); }
        if (this.selectedTarget === payload.deviceId) this.updateSendBar();
    },

    // ===== 设置 =====
    openSettings() {
        this.$('nameInput').value = this.deviceName;
        this.$('settingsOverlay').classList.remove('hidden');
    },
    closeSettings() { this.$('settingsOverlay').classList.add('hidden'); },
    openAbout() { this.$('aboutOverlay').classList.remove('hidden'); },
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
    renderDevices() {
        const grid = this.$('deviceGrid');
        const empty = this.$('emptyDevices');
        const count = this.$('deviceCount');
        const scroll = this.$('deviceScroll');
        const arr = Array.from(this.devices.values());
        count.textContent = arr.length;

        if (arr.length === 0) {
            grid.innerHTML = '';
            empty.classList.remove('hidden');
            scroll.classList.add('hidden');
            return;
        }
        empty.classList.add('hidden');
        scroll.classList.remove('hidden');

        grid.innerHTML = arr.map(d => `
            <div class="device-card ${this.selectedTarget === d.id ? 'selected' : ''}" data-id="${this.escape(d.id)}">
                <div class="device-name">${this.escape(d.name || '未知')}</div>
                <div class="device-meta">
                    <span class="device-meta-ip">${this.formatIP(d.ip)}</span>
                    <span class="device-meta-dot"></span>
                    <span class="device-meta-status">在线</span>
                </div>
            </div>
        `).join('');

        grid.querySelectorAll('.device-card').forEach(el => {
            el.addEventListener('click', () => this.selectDevice(el.dataset.id));
        });
    },

    selectDevice(id) {
        this.selectedTarget = this.selectedTarget === id ? null : id;
        this.renderDevices();
        this.updateSendBar();
    },

    // ===== 文件 =====
    addFiles(files) {
        if (!files?.length) return;
        this.selectedFiles = Array.from(files);
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
            const dev = this.devices.get(this.selectedTarget);
            tn.textContent = dev ? dev.name : '—';
            sb.disabled = !dev || this.activeUpload;
        } else {
            tn.textContent = '选择设备';
            sb.disabled = true;
        }
    },

    // ===== 发送（WebRTC P2P 直传）=====
    async startSend() {
        if (this.activeUpload) return;
        if (!this.selectedFiles.length || !this.selectedTarget) { this.toast('请选择文件和接收方', 'info'); return; }
        const target = this.devices.get(this.selectedTarget);
        if (!target) { this.toast('设备已离线', 'error'); return; }

        this.activeUpload = true;
        this.updateSendBar();

        const files = [...this.selectedFiles];
        let lastErr = null;
        for (let fi = 0; fi < files.length; fi++) {
            const file = files[fi];
            try {
                const label = files.length > 1 ? `发送中 (${fi + 1}/${files.length})` : '发送中';
                this.openProgress(file.name, label);

                const taskId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);

                // 通过 WS 发送传输请求（服务器只做信令转发）
                this.send({
                    type: 'transfer_request',
                    payload: { taskId, fileName: file.name, fileSize: file.size, toId: target.id, fromId: this.deviceId, fromName: this.deviceName }
                });

                const accepted = await this.waitForAccept(taskId, 60000);
                if (!accepted) { this.toast(`${target.name} 拒绝了 ${file.name}`, 'info'); this.closeProgress(); continue; }

                // P2P 直传：文件数据通过 WebRTC DataChannel，不经过服务器
                await this.sendFileP2P(file, taskId, target.id);
                this.showProgressDone();
            } catch (err) {
                lastErr = err;
                this.closeProgress();
            }
        }
        // 进度弹窗若还开着，用户已经能看到"完成"，不重复弹 Toast
        const progressVisible = !this.$('progressOverlay').classList.contains('hidden');
        if (lastErr) {
            this.toast(lastErr.message, 'error');
        } else if (!progressVisible) {
            this.toast(files.length > 1 ? '全部发送完成' : '发送完成', 'success');
        }
        this.clearFiles();
        this.activeUpload = false;
        this.updateSendBar();
    },

    waitForAccept(taskId, timeout) {
        return new Promise(resolve => {
            const timer = setTimeout(() => { this._acceptHandlers.delete(taskId); this._rejectHandlers.delete(taskId); resolve(false); }, timeout);
            this._acceptHandlers.set(taskId, () => { clearTimeout(timer); this._acceptHandlers.delete(taskId); this._rejectHandlers.delete(taskId); resolve(true); });
            this._rejectHandlers.set(taskId, () => { clearTimeout(timer); this._acceptHandlers.delete(taskId); this._rejectHandlers.delete(taskId); resolve(false); });
        });
    },

    // WebRTC P2P 发送
    async sendFileP2P(file, taskId, toId) {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });
        const dc = pc.createDataChannel('file', { ordered: true });
        this._sendPC = pc;
        this._sendDC = dc;
        this._sendTaskId = taskId;

        try {
            // 等待 DataChannel 打开
            const dcReady = new Promise((resolve, reject) => {
                dc.onopen = () => resolve();
                dc.onerror = () => reject(new Error('连接失败'));
                setTimeout(() => reject(new Error('连接超时')), 30000);
            });

            // 创建 offer，等 ICE 收集完成（vanilla ICE，不 trickle）
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await this._waitIceComplete(pc);

            // 发送完整 offer（包含所有 ICE 候选）
            this.send({ type: 'webrtc_offer', payload: { toId, taskId, sdp: pc.localDescription.toJSON() } });

            // 等待 DataChannel 就绪
            await dcReady;

            // 发送文件元信息
            dc.send(JSON.stringify({ type: 'meta', name: file.name, size: file.size, mime: file.type }));

            // 分片发送文件（256KB/片，大分片减少调用开销）
            const chunkSize = 256 * 1024;
            const total = Math.ceil(file.size / chunkSize);
            const startTime = Date.now();
            let sent = 0;
            let lastProgressUpdate = 0;

            // 事件流控：高水位 4MB / 低水位 1MB
            // 高水位不能太高，否则会触发 "RTCDataChannel send queue is full"（浏览器内部限制约 16MB）
            const HIGH_WATERMARK = 4 * 1024 * 1024;
            const LOW_WATERMARK = 1 * 1024 * 1024;
            dc.bufferedAmountLowThreshold = LOW_WATERMARK;
            const waitForBuffer = () => {
                if (dc.bufferedAmount < HIGH_WATERMARK) return Promise.resolve();
                return new Promise(resolve => {
                    dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; resolve(); };
                });
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
                    // 缓冲区满，等降到低水位后重试
                    await new Promise(resolve => {
                        dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; resolve(); };
                    });
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

            // 发送完成信号
            dc.send(JSON.stringify({ type: 'done' }));

            // 等待缓冲区数据全部发送完毕（最多 10 秒，防止死循环）
            const flushStart = Date.now();
            while (dc.bufferedAmount > 0 && Date.now() - flushStart < 10000) {
                await new Promise(r => setTimeout(r, 50));
            }
        } finally {
            // 确保资源清理（即使异常也不泄漏）
            try { dc.close(); } catch {}
            try { pc.close(); } catch {}
            this._sendPC = null;
            this._sendDC = null;
        }
    },

    onTransferAccept(payload) { const h = this._acceptHandlers.get(payload.taskId); if (h) h(); },
    onTransferReject(payload) { const h = this._rejectHandlers.get(payload.taskId); if (h) h(); },
    onTransferComplete(payload) { this.toast('对方已收到文件', 'success'); },

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

    // ===== WebRTC 信令处理（vanilla ICE：SDP 包含完整候选，不需单独交换 candidate）=====
    onWebrtcOffer(payload) {
        const taskId = payload.taskId;
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });
        this._recvPC = pc;
        this._recvTaskId = taskId;

        // 接收方：监听 DataChannel
        pc.ondatachannel = (e) => {
            const dc = e.channel;
            dc.binaryType = 'arraybuffer';
            dc.onmessage = (event) => this.onDataChannelMessage(event.data);
            this._recvDC = dc;
        };

        // 设置远端 offer（已包含所有候选），创建 answer
        pc.setRemoteDescription(new RTCSessionDescription(payload.sdp)).then(() => {
            return pc.createAnswer();
        }).then(answer => {
            return pc.setLocalDescription(answer);
        }).then(() => {
            // 等 ICE 收集完成
            return this._waitIceComplete(pc);
        }).then(() => {
            // 发送完整 answer（包含所有候选）
            this.send({ type: 'webrtc_answer', payload: { toId: payload.fromId, sdp: pc.localDescription.toJSON() } });
        }).catch(err => {
            console.error('WebRTC offer 处理失败:', err);
            this.toast('连接建立失败', 'error');
        });
    },

    onWebrtcAnswer(payload) {
        if (this._sendPC) {
            this._sendPC.setRemoteDescription(new RTCSessionDescription(payload.sdp)).catch(err => {
                console.error('WebRTC answer 设置失败:', err);
            });
        }
    },

    // ===== DataChannel 消息处理（接收方）=====
    onDataChannelMessage(data) {
        if (typeof data === 'string') {
            const msg = JSON.parse(data);
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

                // 如果有文件句柄，创建可写流（流式写盘）
                if (this._recvFileHandle) {
                    this._recvFileHandle.createWritable().then(async w => {
                        // 先把 createWritable 期间缓冲的分片写入（保持顺序）
                        while (this._recvBuffer.length > 0) {
                            const buf = this._recvBuffer.shift();
                            await w.write(buf);
                        }
                        this._recvWritable = w;
                    }).catch(() => { this._recvWritable = null; });
                }

                const item = this.receiveHistory.find(i => i.taskId === this._recvTaskId);
                if (item) { item.status = 'downloading'; item.fileSize = msg.size; this.renderReceiveList(); }

                this.openProgress(msg.name, '接收中');
                this.$('progressSize').textContent = `0 B / ${this.formatSize(msg.size)}`;
            } else if (msg.type === 'done') {
                this._finishReceive();
            }
        } else {
            // 二进制数据：文件分片
            this._recvSize += data.byteLength;

            // 优先写盘（不占内存）
            if (this._recvWritable) {
                this._recvWritable.write(data);
            } else {
                // 移动端：缓冲到内存，每 5MB 写入 IndexedDB 清空缓冲（避免大文件内存溢出）
                this._recvBuffer.push(data);
                this._recvFlushSize += data.byteLength;

                if (this._recvFlushSize >= 5 * 1024 * 1024 && !this._recvFlushing) {
                    this._recvFlushing = true;
                    const bufferToFlush = this._recvBuffer;
                    this._recvBuffer = [];
                    this._recvFlushSize = 0;
                    const blob = new Blob(bufferToFlush, { type: this._recvMime || 'application/octet-stream' });
                    this.dbPutChunk(this._recvTaskId, this._recvChunkIndex++, blob).then(() => {
                        this._recvFlushing = false;
                    });
                }
            }

            const pct = Math.round(this._recvSize / this._recvTotal * 100);
            const elapsed = (Date.now() - this._recvStartTime) / 1000 || 1;
            const speed = this._recvSize / elapsed;
            this.updateProgress(this._recvSize, this._recvTotal, speed, pct);
        }
    },

    async _finishReceive() {
        const item = this.receiveHistory.find(i => i.taskId === this._recvTaskId);

        if (this._recvWritable) {
            // 流式写盘模式（桌面端 Chrome/Edge）：关闭文件流，文件已保存到磁盘
            // 先把缓冲在内存的数据写入（createWritable 异步期间缓存的分片）
            if (this._recvBuffer && this._recvBuffer.length > 0) {
                for (const buf of this._recvBuffer) {
                    await this._recvWritable.write(buf);
                }
            }
            await this._recvWritable.close();
            this._recvWritable = null;
            if (item) { item.status = 'saved'; item.savedToDisk = true; this.renderReceiveList(); }
            this.closeProgress();
            this.toast('文件已保存到磁盘', 'success');
        } else {
            // 移动端：写入剩余分片到 IndexedDB
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
            if (this.isImage(this._recvName) || this.isVideo(this._recvName)) {
                this.openPreviewFromDB(this._recvTaskId, this._recvName);
            } else {
                this.toast('接收完成，点击「查看」可下载', 'success');
            }
        }

        this.send({ type: 'transfer_complete', payload: { taskId: this._recvTaskId, toId: item?.fromId } });

        // 清理
        this._recvBuffer = [];
        this._recvDC = null;
        this._recvFileHandle = null;
        if (this._recvPC) { this._recvPC.close(); this._recvPC = null; }
    },

    // ===== 接收请求 =====
    onTransferRequest(payload) {
        // 微信浏览器不支持接收，自动拒绝
        if (this.isWechat) {
            this.send({ type: 'transfer_reject', payload: { fromId: payload.fromId, taskId: payload.taskId } });
            this.toast('微信浏览器不支持接收文件，已自动拒绝', 'info');
            return;
        }
        // 正在等待接收或正在接收中，自动拒绝新请求（避免 P2P 连接覆盖导致传输中断）
        if (this.pendingReceive || this._recvPC) {
            this.send({ type: 'transfer_reject', payload: { fromId: payload.fromId, taskId: payload.taskId } });
            return;
        }
        const dev = this.devices.get(payload.fromId);
        this.pendingReceive = {
            taskId: payload.taskId,
            fileName: payload.fileName,
            fileSize: payload.fileSize,
            fromId: payload.fromId,
            fromName: payload.fromName || dev?.name || '未知设备'
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
        this.receiveHistory.unshift({ taskId, fileName, fileSize, fromName, time: new Date(), status: 'waiting' });
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

    // ===== 下载已接收的文件 =====
    async startDownload(taskId, fileName) {
        const item = this.receiveHistory.find(i => i.taskId === taskId);
        if (!item) return;

        if (item.savedToDisk) {
            // 文件已通过 File System Access API 保存到磁盘
            this.toast('文件已保存到磁盘', 'info');
            return;
        }

        // 优先用内存 URL（当前会话）
        if (item.blobUrl) {
            if (this.isImage(fileName) || this.isVideo(fileName)) {
                this.openPreviewBlob(item.blobUrl, fileName);
            } else {
                const a = document.createElement('a');
                a.href = item.blobUrl;
                a.download = fileName || '';
                document.body.appendChild(a);
                a.click();
                a.remove();
            }
            return;
        }

        // 刷新后从 IndexedDB 分片恢复
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
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName || '';
            document.body.appendChild(a);
            a.click();
            a.remove();
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
        this.$('previewOverlay').classList.remove('hidden');
    },
    closePreview() {
        const content = this.$('previewContent');
        const video = content.querySelector('video');
        if (video) video.pause();
        content.innerHTML = '';
        this.$('previewOverlay').classList.add('hidden');
        this.previewBlobUrl = null;
    },

    // 保存到相册
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

            // 根据文件扩展名修正 MIME type（安卓需要正确 MIME type 才能保存到相册）
            const correctMime = this.getMimeFromFileName(fileName);
            if (correctMime && blob.type !== correctMime) {
                blob = new Blob([blob], { type: correctMime });
            }

            // 方案1：Web Share API（需要 HTTPS 或 localhost）
            // 可调起 iOS/Android 原生分享面板，含「保存到相册」选项
            if (navigator.share && navigator.canShare) {
                const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({ files: [file], title: fileName });
                    this.toast('已调起分享面板', 'success');
                    return;
                }
            }

            // 方案2：直接下载（安卓 Chrome 会根据 MIME type 自动将图片/视频保存到相册）
            const downloadUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 2000);

            if (isImg) {
                this.toast('图片已下载，可在相册或下载文件夹中查看', 'success');
            } else if (isVid) {
                this.toast('视频已下载，可在相册或下载文件夹中查看', 'success');
            } else {
                this.toast('已下载', 'success');
            }
        } catch (err) {
            if (err.name !== 'AbortError') this.toast('保存失败', 'error');
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
                action = this.isImage(item.fileName) || this.isVideo(item.fileName) ? '查看' : '下载';
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
        this.$('progressName').textContent = name;
        this.$('progressStatus').textContent = status || '传输中';
        this.$('progressFill').style.width = '0%';
        this.$('progressSize').textContent = '0 B / 0 B';
        this.$('progressSpeed').textContent = '—';
        this.$('progressDone').classList.add('hidden');
        this.$('progressOverlay').classList.remove('hidden');
    },
    updateProgress(cur, total, speed, pct) {
        this.$('progressFill').style.width = pct + '%';
        this.$('progressSize').textContent = `${this.formatSize(cur)} / ${this.formatSize(total)}`;
        this.$('progressSpeed').textContent = speed > 0 ? `${this.formatSize(speed)}/s` : '—';
    },
    showProgressDone() {
        this.$('progressStatus').textContent = '完成';
        this.$('progressFill').style.width = '100%';
        this.$('progressDone').classList.remove('hidden');
    },
    closeProgress() { this.$('progressOverlay').classList.add('hidden'); },

    // ===== 状态 =====
    updateStatus(state) {
        const el = this.$('status');
        el.className = 'status ' + state;
        const textMap = {
            'connected': '已连接',
            'connecting': '连接中...',
            'error': '连接错误',
            'lan_only': '仅限局域网访问'
        };
        const textEl = el.querySelector('.status-text') || document.createElement('span');
        textEl.className = 'status-text';
        textEl.textContent = textMap[state] || state;
        if (!el.contains(textEl)) el.appendChild(textEl);
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
    toast(msg, type = 'info') {
        const c = this.$('toastContainer');
        const t = document.createElement('div');
        t.className = 'toast ' + type;
        t.innerHTML = `<span class="toast-dot"></span><span>${this.escape(msg)}</span>`;
        c.appendChild(t);
        setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 150); }, 2800);
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());