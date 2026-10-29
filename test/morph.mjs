// Headless verification of morph targets.
//
// A morph is `base + sum(weight_i * delta_i)` per vertex. Every number involved
// is in the file, so the module's answer is checked against deltas read
// independently on the host side rather than against itself.
//
// Usage: node test/morph-smoke.mjs [wasm] [model.vrm]

import { readFile } from "node:fs/promises";

const WASM = process.argv[2] ?? "src/mod.wasm";
const MODEL = process.argv[3] ?? "test/model.vrm";
const EPS = 1e-5;

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

// Hand the file to the module as an Almide Bytes value ([len][cap][payload]);
// a Bytes export parameter is the i32 address of that value.
function almideBytes(u8) {
  const val = Number(ex.__alloc(8 + u8.length));
  const dv = new DataView(ex.memory.buffer);
  dv.setInt32(val, u8.length, true); dv.setInt32(val + 4, u8.length, true);
  new Uint8Array(ex.memory.buffer, val + 8, u8.length).set(u8);
  return val;
}

const glb = await readFile(MODEL);
ex.open(almideBytes(glb));
  ex.build_all();
  ex.compute_bounds();
  ex.index_expressions();

console.log(`cruth morphs — ${MODEL}\n`);

// ── Independent read of the same file ────────────────────────────────────────

const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
const jsonLen = dv.getUint32(12, true);
const gltf = JSON.parse(glb.slice(20, 20 + jsonLen).toString("utf8"));
const binOffset = 20 + jsonLen + 8;

const flat = [];
(gltf.meshes ?? []).forEach((m, mi) => (m.primitives ?? []).forEach((p) => flat.push({ mesh: mi, p })));

function accessorBase(i) {
  const a = gltf.accessors[i];
  const v = gltf.bufferViews[a.bufferView];
  return binOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
}
function deltaAt(accessorIndex, vertex) {
  const a = gltf.accessors[accessorIndex];
  const stride = gltf.bufferViews[a.bufferView].byteStride ?? 12;
  const at = accessorBase(accessorIndex) + vertex * stride;
  return [dv.getFloat32(at, true), dv.getFloat32(at + 4, true), dv.getFloat32(at + 8, true)];
}

// ── The module agrees on which primitives carry targets ──────────────────────

const withTargets = flat
  .map((f, i) => ({ i, mesh: f.mesh, n: (f.p.targets ?? []).length }))
  .filter((f) => f.n > 0);

let mismatched = 0;
for (const { i, mesh, n } of withTargets) {
  const gotN = Number(ex.primitive_target_count(BigInt(i)));
  const gotMesh = Number(ex.primitive_mesh(BigInt(i)));
  if (gotN !== n || gotMesh !== mesh) {
    mismatched++;
    console.log(`       prim ${i}: got mesh ${gotMesh}/${gotN} targets, want ${mesh}/${n}`);
  }
}
check(mismatched === 0, "every morph primitive's mesh and target count match",
  `${withTargets.length} primitives carry targets`);

// ── Applying a weight moves vertices by exactly the delta ────────────────────

const V = (i, k) => ex.built_vertex_f32(BigInt(i), BigInt(k));

const subject = withTargets.find((f) => f.n >= 5) ?? withTargets[0];
const first = Number(ex.primitive_first_vertex(BigInt(subject.i)));
const count = Number(ex.primitive_vertex_count(BigInt(subject.i)));

// Morph targets are SPARSE — a mouth shape moves mouth vertices and leaves the
// rest at zero. Sampling the first N vertices makes every comparison
// base-vs-base, so the arithmetic passes without ever having been exercised.
// Pick a target that moves something, then sample the vertices it moves.
function movedVertices(accessorIndex, limit) {
  const out = [];
  for (let v = 0; v < count && out.length < limit; v++) {
    if (Math.hypot(...deltaAt(accessorIndex, v)) > 1e-6) out.push(v);
  }
  return out;
}
let targetIndex = -1, sample = [];
for (let t = 0; t < subject.n; t++) {
  const found = movedVertices(flat[subject.i].p.targets[t].POSITION, 64);
  if (found.length >= 8) { targetIndex = t; sample = found; break; }
}
if (targetIndex < 0) {
  console.error("no target on this primitive displaces any vertex — nothing to verify");
  process.exit(1);
}
const accessorIndex = flat[subject.i].p.targets[targetIndex].POSITION;
console.log(`  using prim ${subject.i} target ${targetIndex}: ${sample.length} displaced vertices sampled\n`);

const before = new Map();
for (const v of sample) before.set(v, [V(first + v, 0), V(first + v, 1), V(first + v, 2)]);

const W = 0.75;
ex.clear_target_weights();
ex.set_target_weight(BigInt(subject.i), BigInt(targetIndex), W);
const touched = Number(ex.apply_morphs());
check(touched > 0, "morph_apply reported work", `${touched} vertices`);

let worst = 0, actuallyMoved = 0;
for (const v of sample) {
  const d = deltaAt(accessorIndex, v);
  const got = [V(first + v, 0), V(first + v, 1), V(first + v, 2)];
  for (let k = 0; k < 3; k++) {
    worst = Math.max(worst, Math.abs(got[k] - (before.get(v)[k] + W * d[k])));
  }
  if (Math.hypot(got[0] - before.get(v)[0], got[1] - before.get(v)[1], got[2] - before.get(v)[2]) > 1e-6) {
    actuallyMoved++;
  }
}
check(worst < EPS, `weight ${W} moves vertices by exactly ${W} x delta`,
  `largest error ${worst.toExponential(2)} over ${sample.length} displaced vertices`);
check(actuallyMoved === sample.length, "every sampled vertex actually moved",
  `${actuallyMoved} of ${sample.length}`);

// ── Weights are applied from base, not accumulated ───────────────────────────

ex.apply_morphs();
ex.apply_morphs();
let drift = 0;
for (const v of sample) {
  const d = deltaAt(accessorIndex, v);
  for (let k = 0; k < 3; k++) {
    drift = Math.max(drift, Math.abs(V(first + v, k) - (before.get(v)[k] + W * d[k])));
  }
}
check(drift < EPS, "re-applying the same weight is idempotent",
  `drift after 3 applies: ${drift.toExponential(2)}`);

// ── Zeroing the weight returns the mesh to its base pose ─────────────────────

ex.clear_target_weights();
ex.apply_morphs();
let residual = 0;
for (const v of sample) {
  for (let k = 0; k < 3; k++) residual = Math.max(residual, Math.abs(V(first + v, k) - before.get(v)[k]));
}
check(residual < EPS, "clearing weights restores the base pose",
  `largest residual ${residual.toExponential(2)}`);

// ── Two targets at once sum ──────────────────────────────────────────────────

{
  // A second target that also displaces something, so the sum is not a no-op.
  let other = -1;
  for (let t = 0; t < subject.n; t++) {
    if (t !== targetIndex && movedVertices(flat[subject.i].p.targets[t].POSITION, 8).length >= 8) { other = t; break; }
  }
  if (other >= 0) {
    const a = flat[subject.i].p.targets[targetIndex].POSITION;
    const b = flat[subject.i].p.targets[other].POSITION;
    ex.clear_target_weights();
    ex.set_target_weight(BigInt(subject.i), BigInt(targetIndex), 0.4);
    ex.set_target_weight(BigInt(subject.i), BigInt(other), 0.6);
    ex.apply_morphs();
    let err = 0, differs = 0;
    for (const v of sample) {
      const da = deltaAt(a, v), db = deltaAt(b, v);
      for (let k = 0; k < 3; k++) {
        err = Math.max(err, Math.abs(V(first + v, k) - (before.get(v)[k] + 0.4 * da[k] + 0.6 * db[k])));
      }
      if (Math.hypot(...db) > 1e-6) differs++;
    }
    check(err < EPS, `targets ${targetIndex} and ${other} blend additively`,
      `largest error ${err.toExponential(2)}`);
    check(differs > 0, "the second target contributes to the sampled vertices",
      `${differs} of ${sample.length}`);
  }
}

// ── Cost, since this runs per frame for lip sync ─────────────────────────────

ex.clear_target_weights();
ex.set_target_weight(BigInt(subject.i), BigInt(targetIndex), 0.5);
const t0 = performance.now();
for (let i = 0; i < 30; i++) ex.apply_morphs();
const ms = (performance.now() - t0) / 30;
check(ms < 16, "one morph pass fits in a frame", `${ms.toFixed(2)}ms per apply`);

console.log("");
if (failures.length) {
  console.error(`FAILED — ${failures.length} check(s):`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`passed — morphs verified against the file's own deltas`);
