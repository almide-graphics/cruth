# cruth

> Irish: *cruth* — form, shape.

**VRM/glTF character layer for Almide.** Gives a file its form: parse, geometry,
morph targets, expressions.

## What it is not

cruth draws nothing and depends on no renderer. Everything it produces is bytes
plus pointers, so a consumer uploads them however it likes — WebGPU through
[snaidhm](https://github.com/almide-graphics/snaidhm), WebGL, native, or a test
harness with no GPU at all. The GPU boundary is the app's business.

That is deliberate. Character shading (MToon) is VRM knowledge, not renderer
knowledge, and character parsing is not an app's job either. This is the layer
in between.

## What it does

- **GLB/glTF** — container, JSON, accessors, bufferViews
- **Geometry** — every primitive flattened into one vertex/index pair in a fixed
  layout: `pos(3) + normal(3) + uv(2)`, 32-byte stride, u32 indices
- **Morph targets** — `base + sum(weight_i * delta_i)`, applied from base so
  weights can go up and down
- **VRM 0.x expressions** — `blendShapeMaster` groups resolved to target weights;
  the visemes `a i u e o` plus `blink`, `joy`, `angry`, `sorrow`, `fun`

## Nothing is parsed into a value tree

A glTF document is a lookup table: a primitive names accessor indices, an
accessor names a bufferView, a bufferView names a byte range. Only a dozen field
names are ever needed, so the JSON chunk is scanned once to record byte offsets
and every later lookup is a bounded re-scan of one object.

Building a value tree instead costs a great deal on the wasm leg — `json.parse`
is superlinear there (almide/almide#939: 708 ms and 326 MiB for a 103 KiB glTF)
and the tree it builds is the heap-element list shape whose concat is O(n²)
(C-105). Reading the same document by offset takes **3 ms**.

## Using it

```almide
import cruth
import ffi

// Copy the file into cruth's arena, then read it in place.
let prims = cruth.open(glb_bytes)
let verts = cruth.build_all()
cruth.compute_bounds()
let exprs = cruth.index_expressions()

// Upload however you like — cruth hands out ffi.Regions (base + length).
upload(cruth.vertex_region(), verts * 32, cruth.index_region(), cruth.built_index_count())

// Drive the face.
cruth.clear_target_weights()
cruth.set_expression(mouth_a, 0.8)
cruth.apply_morphs()
```

## Verified against the file, not against itself

`test/reader.mjs` cross-checks every accessor, bufferView and attribute index
the reader reports against an independent `JSON.parse` of the same bytes.
`test/morph.mjs` checks morphed positions against deltas read independently —
and samples only vertices the target actually displaces, because morph targets
are sparse and sampling elsewhere compares base to base and passes without
exercising anything.

```sh
almide build src/mod.almd --target wasm
node test/reader.mjs src/mod.wasm test/model.vrm
node test/morph.mjs  src/mod.wasm test/model.vrm
```

## Notes on the toolchain

- Everything is one module. `import self.X` breaks linking as a consumer grows
  (almide/almide#943); cross-**package** imports work, which is why this is a
  package rather than more submodules. Split once that is fixed.
- Loops perform at most one in-place write each. The second and later mutator of
  a `Bytes` in one loop body costs O(buffer size) (almide/almide#946) — the
  natural three-writes-per-vertex form did not finish in ten minutes; one write
  per loop does the same work in 15 ms.
- Library mode exports **every** function, not only `pub` ones, so the wasm
  surface of a standalone build is wider than the intended API. Consumers that
  `import cruth` see none of them and declare their own surface, so this only
  affects a direct standalone build.
