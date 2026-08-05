package main

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"time"
)

// sniffListener 同端口 HTTPS + HTTP 自动重定向：
// 读取首字节判断是否为 TLS，非 TLS 连接自动 301 重定向到 HTTPS。
// 不在 Accept() 中完成 TLS 握手，而是返回 *tls.Conn，由 http.Server 在每连接
// 独立 goroutine 中异步握手，避免单个慢握手阻塞整个 accept 循环。
type sniffListener struct {
	inner     net.Listener
	tlsConfig *tls.Config
	port      int
}

func newSniffListener(inner net.Listener, tlsConfig *tls.Config, port int) net.Listener {
	return &sniffListener{inner: inner, tlsConfig: tlsConfig, port: port}
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

		// 明文 HTTP → 301 重定向到 HTTPS（异步处理，不阻塞 accept 循环）
		go handleHTTPRedirect(conn, buf[:n], l.port)
	}
}

func (l *sniffListener) Close() error   { return l.inner.Close() }
func (l *sniffListener) Addr() net.Addr { return l.inner.Addr() }

// handleHTTPRedirect 读取明文 HTTP 请求，返回 301 重定向到 HTTPS。
// 在同端口上自动将 http://domain:port/path → https://domain:port/path
func handleHTTPRedirect(conn net.Conn, peeked []byte, port int) {
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))

	reader := bufio.NewReader(&peekConn{Conn: conn, peeked: peeked})
	req, err := http.ReadRequest(reader)
	if err != nil {
		return
	}

	host := req.Host
	if host == "" {
		return
	}
	// 去掉请求中的端口（HTTP 端口），重定向时替换为 HTTPS 端口
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}

	path := req.URL.RequestURI()
	redirectURL := fmt.Sprintf("https://%s:%d%s", host, port, path)

	resp := fmt.Sprintf(
		"HTTP/1.1 301 Moved Permanently\r\n"+
			"Location: %s\r\n"+
			"Connection: close\r\n"+
			"Content-Length: 0\r\n\r\n",
		redirectURL,
	)
	conn.Write([]byte(resp))
}

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
