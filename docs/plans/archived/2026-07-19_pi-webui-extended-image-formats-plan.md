## Goal

Extend `pi-webui` image input from PNG/JPEG/WebP/GIF to the same bounded provider-ready format set proven by `pi-image-drop`: BMP, TIFF, HEIC/HEIF, and AVIF in addition to the existing formats. Success means every accepted source is signature-validated, sanitized, converted or resized predictably, and still obeys Pi model/image settings and inline payload limits.

## Context

- WebUI currently processes all images in `extensions/pi-webui/src/images.ts` with `sharp` and accepts four browser formats.
- Image Drop already proves portable BMP and HEIC fallbacks because patent-safe prebuilt `sharp`/libvips packages do not decode every source format consistently.
- The extensions remain independently installable; WebUI must not import runtime source from `pi-image-drop`.

## Architecture

Keep the processor package-local, but port the validated behavior rather than maintaining a third image abstraction. Detection must use magic bytes. BMP and HEIC use bounded decoders before entering `sharp`; TIFF/AVIF use `sharp`; unsupported output formats normalize to PNG. Preserve animated GIF timing and ICC profiles where the output permits it.

## Non-Goals

- SVG, HTML, PDF, remote image URLs, OCR, annotation, or directory upload.
- Server-side pre-staging, per-image retry, sent-image retention, or configurable limits; those have separate plans.
- A shared published image-processing package.

## Plan

- [x] Add failing cases to `extensions/pi-webui/test/images.test.ts` for BMP, TIFF, HEIC/HEIF, and AVIF signatures, conversion MIME types, corrupt inputs, pixel bombs, metadata removal, ICC retention, animated GIF preservation, aborts, and auto-resize on/off; `npm test` failed before source changes because `detectImageFormat` and `ImageProcessor` were absent.
- [x] Add only the required runtime decoders to `extensions/pi-webui/package.json` and regenerate `package-lock.json` with npm 11.16.0; `npm ls sharp heic-decode bmp-js --workspace @narumitw/pi-webui` resolves BMP 0.1.0, HEIC 2.1.0, and sharp 0.35.3.
- [x] Refactor `extensions/pi-webui/src/images.ts` into cohesive detection, decode, geometry, encode, and bounded-concurrency helpers, porting the proven Image Drop semantics without cross-package imports; all 742 root tests pass, with the pipeline isolated in `src/image-pipeline.ts` and every source file below 1,000 lines.
- [x] Align `extensions/pi-webui/src/pi-settings.ts` malformed `images` object warnings with Image Drop while preserving trusted-project precedence; the new `test/pi-settings.test.ts` failed before implementation and passes in the 742-test root run.
- [x] Expand the browser file-picker accept list and user-facing error/copy contracts in `src/web/index.html`, `app.js`, and browser tests without adding new visible controls; contracts pass and a headless Chrome CDP smoke accepted a real HEIC fixture through picker, drop, and paste with no composer error.
- [x] Update `extensions/pi-webui/README.md` with the source-to-output format table and conversion/privacy behavior; `just pack webui` includes 18 intended runtime files, including the pipeline/vendor declarations, with no tests or fixtures.
- [x] Run `npm --workspace @narumitw/pi-webui run check`, `npm test`, `npm run check`, `git diff --check`, and `just pack webui`; all 742 tests pass, package checks pass, and final inspection is limited to WebUI behavior/dependencies, this plan, and one reusable MEMORY gotcha.

## Risks

- Decoder fallbacks can allocate before dimension checks; parse and validate source dimensions before full BMP/HEIC decode where possible and retain hard pixel ceilings.
- Animated and multipage formats can report aggregate height; enforce limits with per-frame geometry and page count.
- Porting Image Drop code can drift later; keep equivalent behavioral tests named consistently in both packages.

## Rollback / Recovery

The feature is additive. If a decoder proves unreliable on a supported platform, remove only that format from the picker/detector and runtime dependencies while retaining the existing four-format path.

## Completion Checklist

- [x] All eight formats and corrupt/oversized variants are verified by passing `extensions/pi-webui/test/images.test.ts` coverage in the 742-test `npm test` run.
- [x] Existing PNG/JPEG/WebP/GIF behavior, Pi image settings, model capability checks, and inline limits remain verified by `npm run check`.
- [x] Published package contents and dependencies are verified by `just pack webui` and `npm ls sharp heic-decode bmp-js --workspace @narumitw/pi-webui`.
- [x] Headless Chrome CDP smoke evidence shows a real HEIC fixture works through picker, drop, and paste; image processing/send/failure/cancellation remain covered by deterministic image and lifecycle tests with no browser storage.
- [x] Not applicable in this environment: Firefox is not installed; browser-agnostic DOM contracts and server-side format tests cover the same input contract.
