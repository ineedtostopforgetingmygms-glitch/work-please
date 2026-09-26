"""Minimal typed reader/writer for Bedrock (little-endian) NBT, as used by .mcstructure files.

Every value is kept as a (tag_type, value) pair so a file can be read, edited and
written back byte-for-byte identical.
"""
import struct

END, BYTE, SHORT, INT, LONG, FLOAT, DOUBLE, BYTE_ARRAY, STRING, LIST, COMPOUND, INT_ARRAY, LONG_ARRAY = range(13)

_FMT = {BYTE: "b", SHORT: "h", INT: "i", LONG: "q", FLOAT: "f", DOUBLE: "d"}


class _Reader:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def num(self, fmt):
        v = struct.unpack_from("<" + fmt, self.data, self.pos)[0]
        self.pos += struct.calcsize(fmt)
        return v

    def string(self):
        n = self.num("H")
        v = self.data[self.pos:self.pos + n].decode("utf-8")
        self.pos += n
        return v

    def payload(self, t):
        if t in _FMT:
            return self.num(_FMT[t])
        if t == STRING:
            return self.string()
        if t == BYTE_ARRAY:
            return [self.num("b") for _ in range(self.num("i"))]
        if t == INT_ARRAY:
            return [self.num("i") for _ in range(self.num("i"))]
        if t == LONG_ARRAY:
            return [self.num("q") for _ in range(self.num("i"))]
        if t == LIST:
            et = self.num("b")
            return (et, [self.payload(et) for _ in range(self.num("i"))])
        if t == COMPOUND:
            out = {}
            while True:
                tt = self.num("b")
                if tt == END:
                    return out
                k = self.string()
                out[k] = (tt, self.payload(tt))
        raise ValueError(f"unknown tag type {t}")


def load(path):
    r = _Reader(open(path, "rb").read())
    t = r.num("b")
    name = r.string()
    return name, (t, r.payload(t))


def _w_string(out, s):
    b = s.encode("utf-8")
    out += struct.pack("<H", len(b)) + b


def _w_payload(out, t, v):
    if t in _FMT:
        out += struct.pack("<" + _FMT[t], v)
    elif t == STRING:
        _w_string(out, v)
    elif t in (BYTE_ARRAY, INT_ARRAY, LONG_ARRAY):
        f = {BYTE_ARRAY: "b", INT_ARRAY: "i", LONG_ARRAY: "q"}[t]
        out += struct.pack("<i", len(v)) + b"".join(struct.pack("<" + f, x) for x in v)
    elif t == LIST:
        et, items = v
        out += struct.pack("<bi", et, len(items))
        for item in items:
            _w_payload(out, et, item)
    elif t == COMPOUND:
        for k, (tt, vv) in v.items():
            out += struct.pack("<b", tt)
            _w_string(out, k)
            _w_payload(out, tt, vv)
        out += struct.pack("<b", END)
    else:
        raise ValueError(f"unknown tag type {t}")


def dump(path, name, root):
    t, v = root
    out = bytearray(struct.pack("<b", t))
    _w_string(out, name)
    _w_payload(out, t, v)
    open(path, "wb").write(bytes(out))
