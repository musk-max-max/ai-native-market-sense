# 证据凭证：hold unreachable P95（11-12 门禁 #4 附加项）

artifact: services/market/evidence/hold-unreachable-raw-20261104.txt
sha256: f80562cab1225e2790805154bc1459210d0b1b681eaf8d018adf144bfabdaf67
recompute: shasum -a 256 services/market/evidence/hold-unreachable-raw-20261104.txt

- 复算人：a3-backend-market（A3）
- 复算时间：2026-11-04T10:32+08:00（UTC 2026-11-04T02:32Z）
- 复算输出：`f80562cab1225e2790805154bc1459210d0b1b681eaf8d018adf144bfabdaf67  services/market/evidence/hold-unreachable-raw-20261104.txt`（2506 bytes）
- 文件状态：本次复算前后未修改；生成时间 2026-11-04T09:21+08:00，mtime 不入哈希。

## 730cddf5 的来源（同一文件的旧哈希，不是另一份文件）

`730cddf58952aae31700838dbe15478e962111dc5532153c736c920b66fae006` 是对**同一份文件去掉最后一行之后**的字节做 sha256 的结果：

```
sed '$d' services/market/evidence/hold-unreachable-raw-20261104.txt | shasum -a 256
# 730cddf58952aae31700838dbe15478e962111dc5532153c736c920b66fae006
```

原因：生成脚本先 `sha256sum` 再把该行追加进文件；追加后文件的最终字节哈希就是 `f80562ca…`。文件没有第二版、没有被就地覆盖；最后一行是生成时的自指哈希行（旧值），**以本凭证的 `f80562ca…` 为准**。

## 复算 730cddf5 的机器可读等价物

```
python3 - <<'PY'
import hashlib
b = open("services/market/evidence/hold-unreachable-raw-20261104.txt","rb").read()
print(hashlib.sha256(b).hexdigest())                 # f80562ca…
print(hashlib.sha256(b[:b.rfind(b"\n",0,len(b)-1)+1]).hexdigest())  # 730cddf5…
PY
```
