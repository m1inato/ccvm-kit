# echo_server.py PORT... : TCP echo on 0.0.0.0 for each port
import socket, sys, threading
def serve(port):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", port)); s.listen()
    while True:
        c, _ = s.accept()
        def h(c=c):
            try:
                while (d := c.recv(1024)): c.sendall(d)
            except OSError: pass
        threading.Thread(target=h, daemon=True).start()
for p in sys.argv[1:]: threading.Thread(target=serve, args=(int(p),), daemon=True).start()
threading.Event().wait()
