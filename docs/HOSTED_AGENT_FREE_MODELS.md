# SiliconFlow free-model inventory

Checked on **2026-10-08** against the complete expanded [official pricing directory](https://siliconflow.cn/pricing) and [Model Square](https://cloud.siliconflow.cn/models). “Free” here means zero API input/output prices for the exact model, not signup credits, a free Web chat, or a similarly named paid `Pro/` variant. Prices, availability and account terms can change. The public directory is not a price guarantee or proof that a particular key can run a model.

## Hosted coding candidates

These exact models have zero input/output prices and the provider's **Tools** marker. The preset contains these candidates; activation still requires an observed tool call → tool result → final reply and a small OpenCode edit/test run on each selected model. Operator setup and the strict optional subset are owned by [HOSTED_AGENT.md](HOSTED_AGENT.md#selected-free-model-setup).

| Exact SiliconFlow ID | Stable public profile |
|---|---|
| `Qwen/Qwen3.5-4B` | `sf-qwen35-4b` |
| `Qwen/Qwen3-8B` | `sf-qwen3-8b` |
| `Qwen/Qwen2.5-7B-Instruct` | `sf-qwen25-7b` |
| `THUDM/GLM-4-9B-0414` | `sf-glm4-9b-0414` |
| `THUDM/GLM-Z1-9B-0414` | `sf-glmz1-9b-0414` |
| `XingChenAGI/Xing4.0-29B` | `sf-xing40-29b` |

The ChinaTelecom model's SiliconFlow ID differs from [its original vendor repository](https://github.com/XingChen-AGI/Xing4.0-29B-A4B); use the API ID above, not the repository name. A provider Tools marker or original model card does not certify the deployed API's streaming/tool behavior, coding quality or effective input window. GatherThread's existing run/context/resource safeguards remain in force.

## Other free entries, not coding-Agent choices

These entries are free in the checked directory, but are not added to the coding preset. A new task type or uncertain compatibility needs its own reviewed adapter/test, not a silent fallback.

| Use | Exact IDs | Boundary |
|---|---|---|
| Reasoning | `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B` | The current provider card lacks a Tools marker. Tool compatibility remains unverified; do not inherit full R1 capabilities. |
| Translation | `tencent/Hunyuan-MT-7B` | Specialist translation; no generic coding/tool capability claimed. |
| OCR | `deepseek-ai/DeepSeek-OCR`, `PaddlePaddle/PaddleOCR-VL-1.5` | Image/document extraction, not project execution. The directory labels DeepSeek-OCR as a limited free offer. |
| Embeddings | `BAAI/bge-m3`, `BAAI/bge-large-zh-v1.5`, `BAAI/bge-large-en-v1.5` | Vector APIs, not Chat Completions coding Agents. |
| Reranking | `BAAI/bge-reranker-v2-m3` | Ranking API, not a coding Agent. |
| Speech | `XingChenAGI/XingChenGSR-V1.0`, `XingChenAGI/XingChenASR-V3.2-Ultra`, `XingChenAGI/XingChenASR-Diarize-V3.0`, `XingChenAGI/XingChenASR-V3.2`, `Qwen/Qwen3-ASR-1.7B`, `FunAudioLLM/SenseVoiceSmall` | Speech-specific inputs/endpoints. |
| Images | `Kwai-Kolors/Kolors` | Image generation, not project execution. |

Retired models visible in Model Square are not current candidates, even if an old card says Free. In particular, do not use deprecated `TeleAI/TeleChat2`, `THUDM/glm-4-9b-chat`, `Qwen/Qwen2-7B-Instruct` or `Qwen/Qwen2.5-Coder-7B-Instruct`. `Pro/Qwen/Qwen2.5-7B-Instruct`, larger paid Qwen/GLM/DeepSeek models, signup-credit offers and temporary account credits are not part of this zero-price preset.

## Activation checklist

1. Reconfirm each selected model's **exact ID, zero input/output prices, active status and Tools capability** in the operator's Model Square. Record current per-model RPM/TPM without copying account credentials.
2. Confirm the account/service terms permit the intended multi-user application; a real-name verified personal account alone does not establish permission to provide a third-party service.
3. Use only an approved private server key and non-sensitive fixture prompts/source for bounded real checks. Include streaming, a tool result round trip, observed file changes and tests. A failed model is omitted with the strict subset; it is not replaced with a paid or different model.
4. Keep account capacity shared and host/user limits intact. Then activate only the independently authorized environment. Recheck availability/prices on later promotions; stop accepting free-preset work if the premise changes.

Provider references: [Function calling](https://docs.siliconflow.cn/docs/userguide/guides/function-calling), [rate limits](https://docs.siliconflow.cn/docs/userguide/faqs/rate-limit-and-upgradation), [service terms](https://api-docs.siliconflow.cn/docs/legals/terms-of-service).
