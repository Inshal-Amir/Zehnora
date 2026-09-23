"""Read a GGUF header over HTTP range requests (no full download) and report exact tensor types, sizes and metadata.

Usage: python3 zehnora/scripts/gguf-header.py https://huggingface.co/<repo>/resolve/<revision>/<file>.gguf
"""
import struct, sys, urllib.request, collections
URL = sys.argv[1]
CHUNK = 32 * 1024 * 1024
buf = urllib.request.urlopen(urllib.request.Request(URL, headers={"Range": f"bytes=0-{CHUNK-1}"})).read()
pos = 0
def rd(fmt):
    global pos
    v = struct.unpack_from("<" + fmt, buf, pos); pos += struct.calcsize("<" + fmt); return v[0] if len(v) == 1 else v
def rstr():
    global pos
    n = rd("Q"); s = buf[pos:pos+n].decode("utf-8", "replace"); pos += n; return s
SCAL = {0:"B",1:"b",2:"H",3:"h",4:"I",5:"i",6:"f",7:"?",10:"Q",11:"q",12:"d"}
def rval(t):
    if t in SCAL: return rd(SCAL[t])
    if t == 8: return rstr()
    if t == 9:
        et = rd("I"); n = rd("Q")
        if et == 8: return [rstr() for _ in range(n)]
        return [rval(et) for _ in range(n)]
    raise ValueError(t)
assert buf[:4] == b"GGUF"; pos = 4
ver = rd("I"); nt = rd("Q"); nkv = rd("Q")
meta = {}
for _ in range(nkv):
    k = rstr(); t = rd("I"); v = rval(t)
    meta[k] = v if not isinstance(v, list) or len(v) <= 8 else f"<array len {len(v)}>"
# ggml type -> (name, block elems, block bytes)
T = {0:("F32",1,4),1:("F16",1,2),2:("Q4_0",32,18),3:("Q4_1",32,20),6:("Q5_0",32,22),7:("Q5_1",32,24),8:("Q8_0",32,34),
     10:("Q2_K",256,84),11:("Q3_K",256,110),12:("Q4_K",256,144),13:("Q5_K",256,176),14:("Q6_K",256,210),15:("Q8_K",256,292),
     16:("IQ2_XXS",256,66),17:("IQ2_XS",256,74),18:("IQ3_XXS",256,98),19:("IQ1_S",256,50),20:("IQ4_NL",32,18),21:("IQ3_S",256,110),
     22:("IQ2_S",256,82),23:("IQ4_XS",256,136),30:("BF16",1,2),29:("IQ1_M",256,56)}
tensors = []
for _ in range(nt):
    name = rstr(); nd = rd("I"); dims = [rd("Q") for _ in range(nd)]; ty = rd("I"); off = rd("Q")
    n = 1
    for d in dims: n *= d
    tn, be, bb = T.get(ty, (f"type{ty}", 1, 0))
    tensors.append((name, dims, tn, n, n // be * bb))
def group(name):
    if "_exps" in name: return "routed experts (ffn_*_exps)"
    if "_shexp" in name or "shared" in name: return "shared expert"
    if "attn" in name or "ssm" in name: return "attention / linear-attention"
    if name.startswith("token_embd") or name.startswith("output"): return "embeddings / output head"
    return "norms, router, other"
print(f"GGUF v{ver}: {nt} tensors, {nkv} metadata keys")
for k in sorted(meta):
    if k.startswith(("general.", "qwen", "tokenizer.ggml.model")) or ".context_length" in k or "expert" in k or "block_count" in k or "embedding_length" in k or "head_count" in k or "file_type" in k or "quantize" in k:
        print(f"  {k} = {meta[k]}")
tot_n = sum(t[3] for t in tensors); tot_b = sum(t[4] for t in tensors)
print(f"\nTOTAL parameters: {tot_n:,}  tensor bytes: {tot_b:,} ({tot_b/2**30:.2f} GiB)  average {tot_b*8/tot_n:.3f} bits/weight")
by_type = collections.defaultdict(lambda: [0,0,0])
by_group = collections.defaultdict(lambda: [0,0,collections.Counter()])
for name, dims, tn, n, b in tensors:
    by_type[tn][0]+=1; by_type[tn][1]+=n; by_type[tn][2]+=b
    g = by_group[group(name)]; g[0]+=n; g[1]+=b; g[2][tn]+=n
print("\nBy precision type:")
for tn,(c,n,b) in sorted(by_type.items(), key=lambda x:-x[1][2]):
    print(f"  {tn:8s} {c:4d} tensors  {n/1e9:7.3f} B params ({100*n/tot_n:5.1f}%)  {b/2**30:6.2f} GiB  {b*8/n:5.2f} bits/w")
print("\nBy part of the model:")
for g,(n,b,c) in sorted(by_group.items(), key=lambda x:-x[1][1]):
    mix = ", ".join(f"{t} {100*v/n:.0f}%" for t,v in c.most_common())
    print(f"  {g:32s} {n/1e9:7.3f} B params  {b/2**30:6.2f} GiB  {b*8/n:5.2f} bits/w   [{mix}]")
