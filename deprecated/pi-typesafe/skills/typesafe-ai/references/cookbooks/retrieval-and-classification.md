# Retrieval and classification

Use these patterns when a fast first stage produces candidates or a taxonomy constrains the answer space.

## Reranking

A reranker improves the order of a shortlist produced by fast search.
Do not ask the semantic model to scan an entire large corpus when keyword, vector, or hybrid search can cheaply recover a candidate set.

### Pipeline

1. Split and index the corpus with a fast retrieval method such as BM25, embeddings, or a hybrid.
2. Retrieve a shortlist with high recall.
3. Build state for each query-candidate pair.
4. Ask a narrow Noul such as whether the candidate contains the passage the query seeks.
5. Use the returned `noul` value as a comparable relevance score.
6. Sort candidates by that score.
7. Pass the top evidence to the next code or model stage.

A plain yes or no cannot rank candidates, while a Noul supplies a continuous probability of yes.
Keep each pair independently comparable by using the same question and state shape.
Run independent pair evaluations concurrently within service and application limits.

The source cookbook's CLERC legal-retrieval experiment used 30-passage BM25 shortlists for 40 queries.
Its reported top-1 accuracy rose from 5% to 18% and top-10 accuracy from 38% to 62%.
Those numbers demonstrate the method only and are not expected performance for another corpus.
Measure shortlist recall, reranking quality, latency, and cost on the target dataset.

### Failure checks

- If the correct item is absent from the shortlist, reranking cannot recover it.
- Candidate leakage or inconsistent chunking can invalidate evaluation.
- A relevance question that mixes topical similarity with answer support may rank the wrong evidence.
- Scores from different question definitions are not automatically comparable.
- Hidden instructions in candidate text may need a separate guardrail judgment.

## Hierarchical classification

Classify through a taxonomy by asking Choice questions over sibling nodes rather than one enormous flat label set.
A second request at each depth is necessary because the chosen or retained parent paths determine the next options.

### Greedy traversal

At each node, choose the highest-probability child and discard alternatives.
Greedy traversal is cheap but cannot recover from an early mistake.
Use it when the hierarchy is shallow, branches are easy to distinguish, or evaluation shows that recovery adds little value.

### Beam traversal

1. Start with the root path.
2. Ask one Choice question for each retained path's children.
3. Extend each path with every plausible child and its edge probability.
4. Score each path by the geometric mean of decision-edge probabilities.
5. Keep the best `K` paths.
6. Evaluate the next frontier in parallel.
7. Stop when retained paths reach leaves or a bounded stopping rule.
8. Return the highest-scoring leaf and preserve the runner-up for uncertainty policy.

The source cookbook uses this length-normalized score:

```text
path_score = product(edge_probabilities) ** (1 / decisions)
```

Compute it as `exp(mean(log(probabilities)))` for numerical stability.
Do not penalize forced single-child edges as if they were decisions.
Length normalization reduces unfair preference for shallow leaves.

The source examples reported beam width 3 matching 4 of 4 expected leaves while greedy traversal matched 2 of 4.
That small demonstration is not a universal quality claim.
Tune beam width, stopping rules, and escalation using labeled examples from the actual hierarchy.

### Taxonomy checks

- Pin and version the taxonomy used for inference and evaluation.
- Give sibling options distinct names and descriptions.
- Include an unknown or no-fit branch when the taxonomy is not exhaustive.
- Detect cycles, missing children, duplicate labels, and unreachable nodes before model calls.
- Preserve every queried distribution for debugging.
- Escalate when top paths are too close or the winning path contains a weak edge.
- Evaluate leaf accuracy and path quality, not only local node accuracy.
