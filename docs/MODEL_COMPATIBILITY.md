# Model compatibility and provider policy

## Imported Idol artifacts

The repository's `speridlabs/idol` model is identified by its model card as an **image-to-3D Gaussian-splat reconstruction pipeline**. Its configured architecture comprises a latent flow denoiser, octree decoder, Gaussian decoder, and BiRefNet background-removal component. It also relies on DINOv3 ViT-H+/16 and a FLUX.2-dev VAE for image encoding. The four local `.safetensors` paths are LFS pointers; the real payloads are addressed by the SHA-256 OIDs and byte sizes in `docs/REPOSITORY_AUDIT.md`.

**Compatibility decision:** Idol is not a chat, vision-language, text-embedding, image-generation, or web-search model. KAVRON's chat router must never select these files. A future `image-to-3d` engine may use them only after the upstream SDK/runtime, gated encoder access, CUDA/PyTorch dependencies, and GPU capacity have been configured and tested. No such inference engine is active in this initial KAVRON implementation.

## Chat providers

The current backend supports two real protocol adapters:

- **Ollama**: enabled only when `OLLAMA_BASE_URL` is set; model IDs are discovered from `/api/tags`.
- **OpenAI-compatible chat**: enabled only when `OPENAI_API_KEY` and `OPENAI_MODEL` are configured; the base endpoint is configurable. Model discovery/health is performed against the configured endpoint and errors are reported instead of presenting a fake connected model.

Other providers can be added behind the adapter interface. Anthropic, Gemini, and Hugging Face provider-specific protocol adapters are not currently implemented; an OpenAI-compatible endpoint may work only if the service actually implements that contract.

## Optional capabilities

- Vision uses a configured OpenAI-compatible endpoint and explicit vision model; it is unavailable otherwise.
- Image generation requires a configured API key and image model; it is unavailable otherwise.
- Web research requires `TAVILY_API_KEY`; no search results are fabricated.
- Embedding/vector search, model training, and image-to-3D inference are not active.

## Operational requirements

Never load a model simply because a filename or provider exists. Validate architecture, tensor names/shapes, tokenizer/processor, license, runtime, and hardware before enabling. The Idol model card reports NVIDIA CUDA, PyTorch 2.5+, Python 3.10+, external gated DINOv3/FLUX VAE access, and approximately 7.2 GB peak VRAM. The LFS pointers are not a local inference cache; do not smudge/download them in general CI.
