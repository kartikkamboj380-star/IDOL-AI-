# Repository audit

**Audit date:** 2026-11-12
**Audited source:** repository `kartikkamboj380-star/IDOL-AI-`, commit `c5acd7ef39e24a51d49f9d36d997bb0096c82920`.

## Repository inventory

The repository was initially a minimal model mirror, not an application. It contains a 10-byte root README, a GitHub Actions Hugging Face import workflow, its Python transfer/verification script, and the imported `huggingface/speridlabs-idol/` model card, config, assets, and weight pointers. No package manifest, frontend, backend, database, tests, Docker configuration, or application UI existed at audit time.

The application-related languages currently present at audit time were Python (the import utility), YAML (workflow), JSON (model config), and Markdown. The source model includes eight WebP examples, one MP4 reel, one config JSON, a model card, and four `.safetensors` weights. No reusable KAVRON application components were present.

## Model files, Git LFS, and sizes

GitHub's tree stores the four model-weight paths as Git LFS pointers, not their binary payloads. The same is true of the source model's gallery/video assets. This is verified from the pointer format (`version https://git-lfs.github.com/spec/v1`, `oid sha256:…`, `size …`) and source `.gitattributes`. The original binary weights were not downloaded during this audit.

| File | LFS payload bytes | SHA-256 OID |
|---|---:|---|
| `birefnet.safetensors` | 444,466,856 | `44bbc97b041f879975d0d6d538b8e66a25eb04d1f49aab40697544cdd97eaa8e` |
| `decoder.safetensors` | 203,171,696 | `9da4d7676bfcadb1c3fdfbff796e6257dadf82d26ec05be7717c79b2b13a1c4e` |
| `decoder_gs.safetensors` | 949,083,036 | `3087eb8ee5763206a53e4078acf2a1bf382dab5147d407ec13a2cf39c04cc544` |
| `denoiser.safetensors` | 1,482,258,308 | `ded2cacf671bf3978ebc62729087abdbd318ef4752e6805b4c9fc8ffa51fe716` |

The four weights total 3,078,979,896 bytes (about 2.868 GiB). The complete current snapshot totals 3,128,391,338 bytes (about 2.914 GiB); 13 source files are LFS-backed. GitHub's source tree exposes pointer blobs locally, so the physical weight sizes above come from the source API/pointers, not filesystem `stat` of the pointer files.

## Architecture and compatibility

The model card describes **Idol**, an image-to-3D Gaussian-splat pipeline. Its components are a `LatentSeqMMFlowModel` denoiser, `OctreeProbabilityFixedlenDecoder`, `GaussianFixedlenDecoder`, and BiRefNet background removal. Configured external image encoders are DINOv3 ViT-H+/16 and the VAE from FLUX.2-dev. This is not a language model and cannot serve chat, text generation, embeddings, tool calls, or image generation by itself.

The card documents a CUDA/PyTorch workflow, Python 3.10+, PyTorch 2.5+, and NVIDIA GPU requirements. It references gated DINOv3 and FLUX.2-dev assets and requires accepting their model terms. The README reports a 7.2 GB peak VRAM requirement; compatibility and exact requirements depend on upstream code/runtime versions. This repository does not include the SDK source or a runnable inference environment.

## Licensing and security notes

The model card declares Apache-2.0. Confirm that license and any upstream dependency/model terms before redistributing or hosting inference. The two referenced encoder models have their own access and license terms. Model weights and third-party model assets must be treated as untrusted inputs: do not deserialize arbitrary pickle formats, do not execute model-card snippets in production, and pin/scan dependencies and upstream revisions.

The existing import workflow has write access to its checked-out repository branch and downloads a public Hugging Face snapshot on manual dispatch. Keep that scope narrow. The workflow does not provide model inference or private-repository authorization.

## Risks and recommendations

- Do not feed Idol's weights to chat or embedding engines; they are architecture-incompatible.
- Preserve LFS pointers and avoid accidental smudge/download of multi-gigabyte weights during ordinary CI.
- Pin model revisions for reproducible inference and validate the external encoders' permissions.
- Keep model/repository defaults configurable (`KAVRON_DEFAULT_REPO`, `KAVRON_KNOWLEDGE_PATH`, provider environment variables); do not make this repository a permanent hard-coded source.
- Do not claim any model provider is live until a real health check succeeds.
- The KAVRON backend initially uses SQLite and environment-configured providers. Production PostgreSQL, OAuth/GitHub App, vector indexing, and isolated code execution require additional configuration/implementation as marked in the feature matrix.
