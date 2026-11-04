# Minimal stdlib replacement for the few `ip` commands the netns test needs.
# usage (run inside the target netns via nsenter):
#   nl.py veth NAME PEER PEER_NS_PATH | addr IF CIDR | up IF | route-default GW | route-host DST IF | tun NAME
import socket, struct, fcntl, os, sys, ipaddress
def nla(t, payload):
    l = 4 + len(payload); return struct.pack("HH", l, t) + payload + b"\0" * ((4 - l % 4) % 4)
def ifname(n): return n.encode() + b"\0"
def netlink(msgtype, flags, body):
    s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 0); s.bind((0, 0))
    hdr = struct.pack("IHHII", 16 + len(body), msgtype, flags | 0x1 | 0x4, 1, 0)  # REQUEST|ACK
    s.send(hdr + body); r = s.recv(65536)
    err = struct.unpack("i", r[16:20])[0]
    if err: raise OSError(-err, os.strerror(-err))
NEW = 0x400 | 0x200  # CREATE|EXCL
def veth(name, peer, ns_path):
    fd = os.open(ns_path, os.O_RDONLY)
    ifi = struct.pack("BxHiII", 0, 0, 0, 0, 0)
    peerinfo = ifi + nla(3, ifname(peer)) + nla(28, struct.pack("I", fd))   # IFLA_IFNAME, IFLA_NET_NS_FD
    linkinfo = nla(1, b"veth") + nla(2, nla(1, peerinfo))                    # IFLA_INFO_KIND, IFLA_INFO_DATA{VETH_INFO_PEER}
    netlink(16, NEW, ifi + nla(3, ifname(name)) + nla(18, linkinfo))         # RTM_NEWLINK, IFLA_LINKINFO
def ifreq_addr(name, ip):
    return struct.pack("16sH2s4s8s", name.encode(), socket.AF_INET, b"\0\0", socket.inet_aton(ip), b"\0" * 8)
def addr(name, cidr):
    n = ipaddress.ip_interface(cidr); s = socket.socket()
    fcntl.ioctl(s, 0x8916, ifreq_addr(name, str(n.ip)))         # SIOCSIFADDR
    fcntl.ioctl(s, 0x891C, ifreq_addr(name, str(n.netmask)))    # SIOCSIFNETMASK
def up(name):
    s = socket.socket(); r = fcntl.ioctl(s, 0x8913, struct.pack("16sH14s", name.encode(), 0, b""))  # SIOCGIFFLAGS
    flags = struct.unpack("16sH14s", r)[1] | 0x1
    fcntl.ioctl(s, 0x8914, struct.pack("16sH14s", name.encode(), flags, b""))                    # SIOCSIFFLAGS
def sockaddr(ip): return struct.pack("HH4s8s", socket.AF_INET, 0, socket.inet_aton(ip), b"\0" * 8)
def route(dst, mask, gw, dev, flags):
    devbuf = None
    if dev:
        import ctypes; devbuf = ctypes.create_string_buffer(dev.encode() + b"\0"); devptr = ctypes.addressof(devbuf)
    else: devptr = 0
    # struct rtentry (x86_64): ulong pad; sockaddr dst, gw, genmask; ushort flags; short pad2; ulong pad3; ptr tos-ish...; short metric; char* dev; ulong mtu, window; ushort irtt
    rt = struct.pack("L16s16s16sHhLPhxxxxxxPLLH", 0, sockaddr(dst), sockaddr(gw), sockaddr(mask), flags, 0, 0, 0, 0, devptr, 0, 0, 0)
    fcntl.ioctl(socket.socket(), 0x890B, rt)  # SIOCADDRT
def tun(name):
    f = os.open("/dev/net/tun", os.O_RDWR)
    fcntl.ioctl(f, 0x400454CA, struct.pack("16sH", name.encode(), 0x0001 | 0x1000))  # TUNSETIFF IFF_TUN|IFF_NO_PI
    fcntl.ioctl(f, 0x400454CB, 1)  # TUNSETPERSIST
cmd, a = sys.argv[1], sys.argv[2:]
if cmd == "veth": veth(*a)
elif cmd == "addr": addr(*a)
elif cmd == "up": up(*a)
elif cmd == "route-default": route("0.0.0.0", "0.0.0.0", a[0], None, 0x1 | 0x2)          # RTF_UP|RTF_GATEWAY
elif cmd == "route-host": route(a[0], "255.255.255.255", "0.0.0.0", a[1], 0x1 | 0x4)    # RTF_UP|RTF_HOST
elif cmd == "tun": tun(a[0])
