# probe.py tcp|udp HOST PORT [send] -> prints OK / EPERM / TIMEOUT / REFUSED / OTHER:<err>
import socket, sys, errno
proto, host, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    if proto == "tcp":
        s = socket.create_connection((host, port), timeout=2)
        if len(sys.argv) > 4:
            s.sendall(b"ping\n"); data = s.recv(16); print("OK" if data else "NODATA")
        else:
            print("OK")
    else:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
        s.sendto(b"x", (host, port)); print("SENT")
except PermissionError: print("EPERM")
except (socket.timeout, TimeoutError): print("TIMEOUT")
except ConnectionRefusedError: print("REFUSED")
except OSError as e: print("OTHER:" + errno.errorcode.get(e.errno, str(e)))
