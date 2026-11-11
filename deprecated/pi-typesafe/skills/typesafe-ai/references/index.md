# TypeSafe reference index

Use this index to load only the reference needed for the task.
These files are condensed, plain-Markdown snapshots of the upstream TypeSafe documentation retrieved on 2026-09-19.
Consult the linked upstream page when exact current behavior, pricing, model availability, limits, or SDK types matter.

## Local references

| Need | Read |
| --- | --- |
| Understand System One, state, workflow boundaries, use cases, and confidence | [Concepts](concepts.md) |
| Choose and write Choice, Noul, or Score questions | [Question design](question-design.md) |
| Batch questions, combine signals, and gate actions | [Composition patterns](composition-patterns.md) |
| Call the stable HTTP API | [HTTP API](api/http.md) |
| Migrate a preview integration to v1 | [v1 migration](api/migration-v1.md) |
| Use Python | [Python SDK](sdk/python.md) |
| Use JavaScript or TypeScript | [JavaScript SDK](sdk/javascript.md) |
| Route functions, select source values, or recover structure | [Routing and extraction](cookbooks/routing-and-extraction.md) |
| Rerank candidates or traverse a hierarchy | [Retrieval and classification](cookbooks/retrieval-and-classification.md) |
| Verify outputs or turn judgments into learned features | [Verification and learning](cookbooks/verification-and-learning.md) |

## Upstream source map

The local references summarize these upstream pages.
The links below are provenance and freshness checks, not required reading when the local summary is sufficient.

| Local reference | Upstream sources |
| --- | --- |
| `concepts.md` | [System One](https://docs.typesafe.ai/concepts/system-one.md), [building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md), [state](https://docs.typesafe.ai/concepts/state.md), [use-case map](https://docs.typesafe.ai/concepts/use-case-map.md), [confidence](https://docs.typesafe.ai/confidence.md) |
| `question-design.md` | [primitives](https://docs.typesafe.ai/primitives.md), [Choice](https://docs.typesafe.ai/primitives/choice.md), [Noul](https://docs.typesafe.ai/primitives/noul.md), [Score](https://docs.typesafe.ai/primitives/score.md) |
| `composition-patterns.md` | [speculative fan-out](https://docs.typesafe.ai/patterns/fan-out.md), [composite scoring](https://docs.typesafe.ai/patterns/composite-scoring.md) |
| `api/http.md` | [HTTP API](https://docs.typesafe.ai/api.md) |
| `api/migration-v1.md` | [migration guide](https://docs.typesafe.ai/migrating-to-v1.md) |
| `sdk/python.md` | [Python SDK](https://docs.typesafe.ai/sdk/python.md) |
| `sdk/javascript.md` | [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md) |
| `cookbooks/routing-and-extraction.md` | [function calling](https://docs.typesafe.ai/cookbooks/function_calling.md), [pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook.md), [structure recovery](https://docs.typesafe.ai/cookbooks/autoformat.md) |
| `cookbooks/retrieval-and-classification.md` | [reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md), [hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md) |
| `cookbooks/verification-and-learning.md` | [citation verification](https://docs.typesafe.ai/cookbooks/citation_check.md), [structured-data extraction cascade](https://docs.typesafe.ai/cookbooks/sde_cascade.md), [feature discovery](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery.md) |

The upstream discovery index is [llms.txt](https://docs.typesafe.ai/llms.txt).
It includes pages that this skill does not bundle.
