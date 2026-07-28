// Headless verification of the byte-floor glTF reader.
//
// The reader never builds a JSON value tree — it records byte offsets and
// re-scans one object per lookup — so every answer it gives is checked here
// against the same file parsed by JSON.parse on the host side. A disagreement
// on any accessor, bufferView or attribute index fails the run.
//
// Usage: node test/gltf-smoke.mjs [path/to/aivarium.wasm] [model.glb ...]

import { readFile } from "node:fs/promises";

const WASM = process.argv[2] ?? "src/mod.wasm";
const MODELS = process.argv.slice(3);

const failures = [];
function check(ok, label, detail) {
  if (ok) { console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

const inert = new Proxy({}, { get: () => () => 0n });
const dom = new Proxy({ commit_str: () => 0n }, { get: (t, k) => (k in t ? t[k] : () => 0n) });

const { instance } = await WebAssembly.instantiate(await readFile(WASM), {
  wasi_snapshot_preview1: inert, gpu: inert, dom, font_data: inert,
});
const ex = instance.exports;
if (ex._start) { try { ex._start(); } catch { /* no main */ } }

console.log(`cruth reader — ${WASM}\n`);

// ── A synthetic GLB whose every field is known ───────────────────────────────
// Deliberately awkward: an interleaved bufferView with an explicit byteStride,
// a non-zero accessor byteOffset, a second mesh (so primitives must flatten),
// a string value containing braces and an escaped quote (which a naive scanner
// walks straight through), and keys ordered so a prefix match would pick wrong.

function synthetic() {
  const bin = new Uint8Array(512);
  const gltf = {
    asset: { version: "2.0", generator: 'a {nested} \\"quoted\\" generator, [really]' },
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, byteOffset: 4, componentType: 5126, count: 3, type: "VEC2" },
      { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" },
      { bufferView: 2, byteOffset: 16, componentType: 5125, count: 3, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 128, byteStride: 32 },
      { buffer: 0, byteOffset: 128, byteLength: 64 },
      { buffer: 0, byteOffset: 192, byteLength: 64 },
    ],
    meshes: [
      { name: "first", primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 3 }] },
      { name: "second", primitives: [
        { attributes: { POSITION: 0, TEXCOORD_0: 2, NORMAL: 1 }, indices: 4 },
        { attributes: { POSITION: 0 } },
      ]},
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const jb = new TextEncoder().encode(JSON.stringify(gltf));
  const jc = new Uint8Array(Math.ceil(jb.length / 4) * 4).fill(0x20);
  jc.set(jb);
  const total = 12 + 8 + jc.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jc.length, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jc, 20);
  const bh = 20 + jc.length;
  dv.setUint32(bh, bin.length, true); dv.setUint32(bh + 4, 0x004e4942, true);
  out.set(bin, bh + 8);
  return { glb: out, gltf, binOffset: bh + 8 };
}

function stage(glb) {
  const cap = Number(ex.file_capacity());
  if (glb.length > cap) throw new Error(`file ${glb.length} exceeds staging capacity ${cap}`);
  new Uint8Array(ex.memory.buffer, Number(ex.file_ptr()), glb.length).set(glb);
  return Number(ex.open_staged(BigInt(glb.length)));
}

// Everything the reader is asked, answered independently from the host's parse.
function crossCheck(label, glb, gltf, binOffset) {
  const prims = stage(glb);
  check(Number(ex.error_code()) === 0, `${label}: opened cleanly`, `error ${Number(ex.error_code())}`);

  const expectPrims = (gltf.meshes ?? []).reduce((n, m) => n + (m.primitives?.length ?? 0), 0);
  check(prims === expectPrims, `${label}: primitives flattened across meshes`,
    `got ${prims}, want ${expectPrims}`);
  check(Number(ex.accessor_count()) === (gltf.accessors ?? []).length,
    `${label}: accessor count`, `got ${Number(ex.accessor_count())}`);
  check(Number(ex.view_count()) === (gltf.bufferViews ?? []).length,
    `${label}: bufferView count`, `got ${Number(ex.view_count())}`);
  check(Number(ex.bin_offset()) === binOffset,
    `${label}: BIN chunk located`, `got ${Number(ex.bin_offset())}, want ${binOffset}`);

  // Accessors: count, component type, absolute base, stride.
  let bad = 0;
  const detail = [];
  (gltf.accessors ?? []).forEach((a, i) => {
    const bi = BigInt(i);
    const wantCount = a.count;
    const wantComp = a.componentType;
    const view = gltf.bufferViews[a.bufferView];
    const wantBase = binOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const packed = 12;
    const wantStride = view.byteStride ?? packed;
    const got = {
      count: Number(ex.staged_accessor_count(bi)),
      comp: Number(ex.staged_accessor_component(bi)),
      base: Number(ex.staged_accessor_base(bi)),
      stride: Number(ex.staged_accessor_stride(bi, BigInt(packed))),
    };
    if (got.count !== wantCount || got.comp !== wantComp || got.base !== wantBase || got.stride !== wantStride) {
      bad++;
      detail.push(`#${i} got ${JSON.stringify(got)} want {count:${wantCount},comp:${wantComp},base:${wantBase},stride:${wantStride}}`);
    }
  });
  check(bad === 0, `${label}: every accessor resolves`, detail.slice(0, 2).join("; "));

  // Attributes and indices, per flattened primitive.
  const flat = [];
  for (const m of gltf.meshes ?? []) for (const p of m.primitives ?? []) flat.push(p);
  let attrBad = 0;
  const attrDetail = [];
  flat.forEach((p, i) => {
    const bi = BigInt(i);
    const want = {
      pos: p.attributes?.POSITION ?? -1,
      nrm: p.attributes?.NORMAL ?? -1,
      uv: p.attributes?.TEXCOORD_0 ?? -1,
      idx: p.indices ?? -1,
    };
    const got = {
      pos: Number(ex.staged_attribute(bi, 0n)),
      nrm: Number(ex.staged_attribute(bi, 1n)),
      uv: Number(ex.staged_attribute(bi, 2n)),
      idx: Number(ex.staged_indices(bi)),
    };
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      attrBad++;
      attrDetail.push(`prim ${i}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
  });
  check(attrBad === 0, `${label}: every primitive's attributes resolve`, attrDetail.slice(0, 2).join("; "));
}

const s = synthetic();
crossCheck("synthetic", s.glb, s.gltf, s.binOffset);

// ── Malformed input must be reported, never guessed at ───────────────────────

console.log("");
const tooSmall = new Uint8Array(8);
check(stage(tooSmall) === -1 && Number(ex.error_code()) === 1, "a truncated file is rejected",
  `error ${Number(ex.error_code())}`);

const badMagic = new Uint8Array(s.glb);
badMagic[0] = 0x00;
check(stage(badMagic) === -1 && Number(ex.error_code()) === 2, "a wrong magic is rejected",
  `error ${Number(ex.error_code())}`);

const jsonOnly = (() => {
  const jb = new TextEncoder().encode('{"asset":{"version":"2.0"}}');
  const jc = new Uint8Array(Math.ceil(jb.length / 4) * 4).fill(0x20); jc.set(jb);
  const total = 12 + 8 + jc.length;
  const out = new Uint8Array(total); const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jc.length, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jc, 20); return out;
})();
check(stage(jsonOnly) === -1 && Number(ex.error_code()) === 4, "a file with no BIN chunk is rejected",
  `error ${Number(ex.error_code())}`);

// ── Real models, when supplied ───────────────────────────────────────────────

for (const path of MODELS) {
  console.log("");
  const glb = await readFile(path).catch(() => null);
  if (!glb) { console.log(`  skipped — ${path} not found`); continue; }
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const gltf = JSON.parse(glb.slice(20, 20 + jsonLen).toString("utf8"));
  const binOffset = 20 + jsonLen + 8;
  const name = path.split("/").pop();
  const t = performance.now();
  crossCheck(name, glb, gltf, binOffset);
  console.log(`       read in ${(performance.now() - t).toFixed(0)}ms ` +
    `(${(glb.length / 1048576).toFixed(1)} MiB file, ${(jsonLen / 1024).toFixed(0)} KiB JSON)`);
}

console.log("");
if (failures.length) {
  console.error(`FAILED — ${failures.length} check(s):`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log("passed — every field the reader returns matches an independent parse");
