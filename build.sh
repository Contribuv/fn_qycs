#!/bin/bash
# ============================================================
# 千盈传送 - 双架构交叉编译脚本 (x86_64 + ARM64)
# 在 Linux/macOS/WSL 上运行，输出到 package/app/ 对应子目录
# 用法:
#   ./build.sh           # 编译双架构
#   ./build.sh amd64     # 仅编译 amd64
#   ./build.sh arm64     # 仅编译 arm64
#   ./build.sh pack      # 编译后调用 fnpack 打包 FPK
# ============================================================
set -e

# 项目根目录（脚本所在目录）
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_SRC="${ROOT_DIR}/server-src"
PACKAGE_DIR="${ROOT_DIR}/package"
APP_DIR="${PACKAGE_DIR}/app"
SERVER_OUT="${APP_DIR}/server"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[BUILD]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# 检测 Go 环境
if ! command -v go >/dev/null 2>&1; then
    err "未找到 Go 编译器，请先安装 Go 1.21+"
    exit 1
fi

GO_VERSION=$(go version)
log "Go 版本: ${GO_VERSION}"

# 目标架构列表
TARGET_ARCHS=()
case "${1:-all}" in
    amd64|x86_64) TARGET_ARCHS=("amd64") ;;
    arm64|aarch64) TARGET_ARCHS=("arm64") ;;
    all|"") TARGET_ARCHS=("amd64" "arm64") ;;
    pack) TARGET_ARCHS=("amd64" "arm64") ;;
    *) err "未知参数: $1（支持: amd64/arm64/all/pack）"; exit 1 ;;
esac

# 准备输出目录
mkdir -p "${SERVER_OUT}"

# 编译单个架构
build_arch() {
    local arch="$1"
    local goarch="$arch"

    log "===== 编译架构: ${arch} ====="

    log "[1/1] 编译主服务 (fn_qycs-server-${arch})..."
    (
        cd "${SERVER_SRC}"
        CGO_ENABLED=0 GOOS=linux GOARCH="${goarch}" \
        go build \
            -ldflags="-s -w" \
            -o "${SERVER_OUT}/fn_qycs-server-${arch}" \
            .
    )
    if [ ! -f "${SERVER_OUT}/fn_qycs-server-${arch}" ]; then
        err "主服务编译失败: ${arch}"
        exit 1
    fi
    chmod +x "${SERVER_OUT}/fn_qycs-server-${arch}"
    log "  输出: ${SERVER_OUT}/fn_qycs-server-${arch}"
}

# 验证二进制架构
verify_binary() {
    local file="$1"
    local expect="$2"
    if command -v file >/dev/null 2>&1; then
        local info
        info=$(file "${file}")
        case "${expect}" in
            amd64) echo "${info}" | grep -q "x86-64" && log "  验证通过: ${info}" || warn "  架构不匹配: ${info}" ;;
            arm64) echo "${info}" | grep -q "ARM aarch64" && log "  验证通过: ${info}" || warn "  架构不匹配: ${info}" ;;
        esac
    fi
}

# 打包 FPK
pack_fpk() {
    local FNPACK=""
    # 查找 fnpack 工具
    for candidate in "${ROOT_DIR}/fnpack" "${ROOT_DIR}/fnpack.exe" "/usr/local/bin/fnpack" "/usr/bin/fnpack"; do
        if [ -x "${candidate}" ]; then
            FNPACK="${candidate}"
            break
        fi
    done

    if [ -z "${FNPACK}" ]; then
        warn "未找到 fnpack 工具，跳过打包步骤"
        warn "请从 https://developer.fnnas.com 下载 fnpack 并放置到 PATH 或项目根目录"
        return 0
    fi

    log "===== 打包 FPK ====="
    # fnpack 1.2+ 使用子命令：fnpack build -d <目录>，输出 <appname>.fpk 到当前工作目录
    (
        cd "${ROOT_DIR}"
        "${FNPACK}" build -d "${PACKAGE_DIR}" 2>&1 || {
            warn "fnpack 打包失败，请检查 manifest 格式"
            return 1
        }
    )

    local appname
    appname=$(grep '^appname' "${PACKAGE_DIR}/manifest" | awk -F'=' '{print $2}' | tr -d ' ')
    [ -z "${appname}" ] && appname="fn_qycs"
    if [ -f "${ROOT_DIR}/${appname}.fpk" ]; then
        log "打包成功: ${ROOT_DIR}/${appname}.fpk"
    fi
}

# ===== 主流程 =====
log "项目根目录: ${ROOT_DIR}"
log "目标架构: ${TARGET_ARCHS[*]}"

for arch in "${TARGET_ARCHS[@]}"; do
    build_arch "${arch}"
    verify_binary "${SERVER_OUT}/fn_qycs-server-${arch}" "${arch}"
done

log "===== 编译完成 ====="
log "主服务输出: ${SERVER_OUT}"
ls -lh "${SERVER_OUT}" 2>/dev/null || true

# 如果指定 pack 参数，进行打包
if [ "${1:-}" = "pack" ]; then
    pack_fpk
fi
