# Dread Lens — screenshot modpack

A Modrinth modpack (`.mrpack`) for taking **screenshots** with two horror
shaders at full quality:

- **[Hysteria Shaders](https://modrinth.com/shader/hysteria-shaders)**: the default. It's based on Photon, has volumetric fog and clouds, and supports Distant Horizons.
- **[Insanity Shader](https://modrinth.com/shader/insanity-shader)**: the original BSL-based horror shader and Hysteria's predecessor.

The pack has every performance mod that doesn't change how the game looks.
Nothing here lowers shader quality to gain FPS: the extra FPS comes from
rendering, memory and chunk-loading optimizations, not from cutting visuals.

**Minecraft 1.21.1 · Fabric**. This is the newest version both shaders and the
whole mod list support reliably.

## Install

1. Download the `.mrpack` from the latest release in this repo's **Releases** page. GitHub Actions builds it and launch-tests it on every change.
2. **Modrinth App**: *Create instance → Import from file → pick the `.mrpack`*.
   **Prism Launcher**: *Add Instance → Import → pick the `.mrpack`*.
3. Give it memory: **8 GB** (at least 6 GB) because of Distant Horizons.
   In Modrinth App go to *Instance → Settings → Java and memory*.
   Recommended JVM arguments for Java 21:
   ```
   -XX:+UseZGC -XX:+ZGenerational -XX:+AlwaysPreTouch -XX:+DisableExplicitGC
   ```
4. Launch. Shaders are already on with Hysteria selected. To switch to
   Insanity, go to *Options → Video Settings → Shader Packs*, or press **O**.

## What's inside

| Purpose | Mods |
|---|---|
| Rendering / FPS | Sodium, Iris, ImmediatelyFast, Entity Culling, BadOptimizations, Dynamic FPS |
| Logic / memory / loading | Lithium, FerriteCore, ModernFix |
| Visuals | Distant Horizons (LOD terrain far past render distance), Continuity (connected textures) |
| Screenshot tools | Freecam, Zoomify, Fabrishot (high-res capture), Flashback (replay + free camera), Chunky (pre-generate a world) |
| Settings UI | Sodium Extra, Mod Menu |

The full list, with the reason for each mod, is in [`pack/pack.json`](pack/pack.json).
Required dependencies (Fabric API, YACL, and so on) are resolved automatically.

## Screenshot workflow

1. **Load the scene fully** before you shoot. Pre-generate the nearby area with
   `/chunky radius 256` then `/chunky start`, and let Distant Horizons build
   the far LODs itself (it has its own distant generator). Using Chunky over a
   huge radius can leave holes in DH's LODs.
2. **Frame the shot**: use **Freecam** to move the camera anywhere, and hold
   **C** for **Zoomify** to zoom. Press **F1** to hide the HUD.
3. **Capture**:
   - **F2** takes a normal screenshot at window resolution.
   - **Fabrishot** captures at a custom resolution such as 4K or 8K, whatever
     your window size. Set the resolution and the key in *Mod Menu → Fabrishot*.
   - **Flashback** records gameplay. You can then scrub the replay, stop time and
     place the camera anywhere, which is great for lightning, mobs and
     action shots.
4. **Crank the shader**: *Shader Packs → Shader Pack Settings*. Since this is
   for stills, raise the shadow resolution, volumetric fog and cloud quality,
   and SSR/SSAO quality. Low FPS doesn't matter for a screenshot.

**Distant Horizons + Insanity:** Insanity has no Distant Horizons support, so
far-away LOD terrain renders without shading. When you use Insanity, lower the
Distant Horizons render distance or turn it off in its settings.

## Building the pack yourself

```
python3 scripts/build_mrpack.py        # writes dist/*.mrpack (needs access to api.modrinth.com)
```

`scripts/build_mrpack.py` resolves each mod on Modrinth for the configured
Minecraft version and pulls in required dependencies. It reads every
candidate jar's `fabric.mod.json`, including jars bundled inside other jars,
and checks its `depends` and `breaks` rules against the mods already chosen.
The result is a set Fabric Loader will accept.
- Releases are preferred over betas and alphas.
- Mods earlier in `pack.json` win conflicts. For example, Iris is listed
  before Sodium, so the newest *stable* Iris decides which Sodium version is
  used.
- Optional mods with no compatible build are skipped with a warning.
- It generates `config/iris.properties` so the default shader is enabled on
  first launch.

`scripts/inspect_versions.py <mc> <slug>...` lists recent versions of mods
along with their dependency rules, which helps when changing pins.

To add or remove mods, or to change the Minecraft version, edit
[`pack/pack.json`](pack/pack.json). Files in [`pack/overrides/`](pack/overrides)
are copied into the instance.

CI ([`.github/workflows/build-pack.yml`](.github/workflows/build-pack.yml)) does three things:
1. Builds the pack.
2. Boots it to the title screen headlessly with `scripts/smoke_test.py`.
3. Publishes the `.mrpack` as a GitHub release.
