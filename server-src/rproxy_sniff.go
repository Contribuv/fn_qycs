package main

import (
	"crypto/tls"
	"net"
	"time"
)

// sniffListener 仅 HTTPS 嗅探：
// 读取首字节判断是否为 TLS，非 TLS 连接直接关闭（不做 HTTP->HTTPS 重定向）。
// 不在 Accept() 中完成 TLS 握手，而是返回 *tls.Conn，由 http.Server 在每连接
// 独立 goroutine 中异步握手，避免单个慢握手阻塞整个 accept 循环。
type sniffListener struct {
	inner     net.Listener
	tlsConfig *tls.Config
}

func newSniffListener(inner net.Listener, tlsConfig *tls.Config) net.Listener {
	return &sniffListener{inner: inner, tlsConfig: tlsConfig}
}

func (l *sniffListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.inner.Accept()
		if err != nil {
			return nil, err
		}

		// 设置读取超时，避免恶意连接挂起 accept
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))

		// 读取首字节判断协议
		buf := make([]byte, 1)
		n, err := conn.Read(buf)
		if err != nil || n == 0 {
			conn.Close()
			continue
		}

		// TLS ClientHello: 首字节 0x16
		if buf[0] == 0x16 {
			// 返回 *tls.Conn（不握手），由 http.Server 在每连接 goroutine 中异步握手；
			// 设置握手超时，防止半开连接堆积。Accept 立即返回，不阻塞。
			conn.SetReadDeadline(time.Now().Add(10 * time.Second))
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			return tls.Server(&peekConn{Conn: conn, peeked: buf[:n]}, l.tlsConfig), nil
		}

		// 非 TLS（明文 HTTP）连接：仅提供 HTTPS 访问，直接关闭，不做重定向
		conn.Close()
	}
}

func (l *sniffListener) Close() error   { return l.inner.Close() }
func (l *sniffListener) Addr() net.Addr { return l.inner.Addr() }

// peekConn 包装已读取了部分数据的连接
type peekConn struct {
	net.Conn
	peeked []byte
}

func (c *peekConn) Read(b []byte) (int, error) {
	if len(c.peeked) > 0 {
		n := copy(b, c.peeked)
		c.peeked = c.peeked[n:]
		return n, nil
	}
	return c.Conn.Read(b)
}
