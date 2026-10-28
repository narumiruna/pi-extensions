# Frontier case study: Pi native vs Remote V2 compaction

This case uses code, tests and engineering reports from Frontier, an AI infrastructure project with more than 80,000 lines of code. On the same retained conversation, the plugin fully answered 8 of 12 question bundles after compaction; Pi native compaction fully answered 6. Neither recovered the five exact host values asked in one bundle. This is a small practical example of what each method retained, not a general ranking.

The accompanying [evidence.json](evidence.json) contains all 12 questions, explicit expected components, anonymized observed answers, judgments and measured usage. The package's [synthetic benchmark](../../README.md) remains the route for repeated, controlled studies. This case adds source-grounded evidence; it does not replace that benchmark or use its confirmatory protocol.

## Setup

| Item | Setting |
| --- | --- |
| Run date | October 18, 2026 |
| Platform | Linux; Node 24.21.0 |
| Pi / plugin | Pi 1.3.0; @narumitw/pi-codex-compact 0.56.1, installed generated entry |
| Model | gpt-6.1-sol; selected Pi thinking level xhigh |
| Provider | Same Responses-compatible backend and credentials for both methods |
| Local fixture test | Python 3.10.6; Torch 2.1.0+cu121; CPU-only pytest |
| Conversation | 38 user/assistant/tool-result messages; 33,815 Pi-estimated tokens |
| Native preparation | 36 messages summarized; no split turn |
| Retention | keepRecentTokens=2048 in both sessions; plugin retained-user-text budget 64000 |
| Execution | Manual compaction; automatic compaction disabled; tools disabled during recall |
| Sample | One compaction and one 12-question response per method |

The model name is the contributor's normalized label, not a separately verified provider revision. Deployment details and credentials are omitted. Both methods used the same active model and backend.

Both sessions were seeded from the same frozen conversation and had identical Pi preparation. All queried facts were before the recent tail. The tail contained low-information archive markers rather than answers, so questions tested compacted history instead of reading the kept messages directly.

The 2048-token recent window was an experiment setting to put facts into the summarized region, not a recommended production default. reserveTokens=100000 was identical in both isolated sessions; automatic triggers were disabled. The plugin used remote-v2 with its 64000 approximate retained-user-text budget. Equal Pi retention settings do not mean equal information capacities: native keeps recent all-role messages plus a summary; the plugin keeps selected user text plus an opaque checkpoint. Plugin scores evaluate that replacement history as a whole, not the opaque item alone.

Pi selected xhigh for both sessions and their recall. Native compaction sent reasoning.effort=xhigh. The plugin's Remote V2 maintenance payload did not include reasoning. This difference is part of the observed implementation, so the comparison does not isolate an identical reasoning budget.

The comparison used real Pi sessions, provider serialization and the installed extension. Separate continuation checks exercised session resume and reload. Runs were sequential with no counterbalancing. Existing Pi retries were enabled identically: maxRetries=3, baseDelay=8s, maxAgentDelay=60s. Provider cache state was not controlled.

## What went into the conversation

The constructed history mixed actual source excerpts and outputs with short connecting narration:

- CUTLASS observer code and tests: identify the owning attention layer from two quant-scale object identities, read existing host context, and leave native results and exceptions unchanged.
- A commit diff for the observer and its tests, plus repeated Git/source inspections as archive noise.
- A fresh pytest collection failure caused by a missing import path, followed by reuse of the existing Torch installation: 6 passed in 1.54s. No dependencies were installed.
- Historical controlled-fixture shapes, BF16 reference rows, negative controls and validation counts.
- An early “GPU pending” statement followed by a terminal Succeeded result, and a plan marking steps 1–5 complete while full-model evidence remained open.

Historical GPU and engine results were quoted as source material; they were not rerun for this experiment. The transcript is a constructed engineering case, not a claimed production session log.

A representative exact-value fixture was:

```python
selected = SimpleNamespace(
    num_actual_tokens=11,
    prefill_max_seq_len=384,
)
dp_metadata = SimpleNamespace(local_sizes=[5, 6])
batch_num_tokens = 16
graph_mode = "PIECEWISE"
attention_layers = {"layer.3": "owned"}
```

This illustrative excerpt keeps the original values; it is not the full conversation or an executable test.

## Procedure and grading

1. Seed two isolated Pi sessions from the identical frozen history and verify identical compaction preparation.
2. Compact once with the native path and once with the installed plugin. Require a genuine Remote V2 checkpoint for the plugin: fromHook=true, the expected checkpoint kind/protocol, nonempty opaque content, and no native summary request.
3. Ask the same 12 questions in a single JSON response using only retained context. Disable tools and require unknown when information is absent.
4. Manually compare each response with the source, then retain the question, expected components, response and judgment in evidence.json.

PASS means all required components were recovered; PARTIAL means only some were recovered; MISSING means all requested exact fields in that bundle were absent. This is retrospective, non-blinded component review, not an automated metric or a model judge. Different bundles contain different numbers of facts, so question counts are descriptive rather than equal-weight measures of information.

## Results

| Judgment | Pi native | Plugin |
| --- | ---: | ---: |
| PASS | 6/12 (50.0%) | 8/12 (66.7%) |
| PARTIAL | 5/12 | 3/12 |
| MISSING | 1/12 | 1/12 |

The plugin had two more fully retained bundles, a 16.7 percentage-point difference in this case. Questions from the same response are not independent samples; no significance test or confidence interval is claimed.

| Question | Required evidence | Pi native | Plugin | Observed difference |
| --- | --- | --- | --- | --- |
| Q1 | Ownership and forbidden reads | PARTIAL | PARTIAL | Both answers omit the exact layer.3 -> owned mapping. The plugin also retains the concrete owner path. |
| Q2 | Observer failure versus native behavior | PARTIAL | PASS | Native merges distinct metadata states and cannot name their exact markers. The plugin retains unavailable/unsupported/error distinctions and both identity guarantees. |
| Q3 | Exact host values | MISSING | MISSING | Both answer unknown for all five fields, even though the plugin compaction request includes them. |
| Q4 | Fresh test result and environment correction | PASS | PASS | Both distinguish an import-path collection failure from a tested behavior failure and retain the fresh result. |
| Q5 | Corrected terminal state | PASS | PASS | Both retain the correct terminal state and exact original identifier. Identifier equality was checked locally before redaction. |
| Q6 | Shapes and numeric references | PASS | PASS | Both retain both shapes and both complete reference rows. |
| Q7 | Negative controls | PASS | PASS | Both retain the required controls and errors. |
| Q8 | Historical validation versus fresh work | PARTIAL | PARTIAL | Both omit 1.04s. The plugin reports 25 affected tests but leaves a separately identified recorder-only count unknown. The source label ambiguity is retained rather than graded as a plugin hallucination. |
| Q9 | Limits of a passing result | PASS | PASS | Both preserve all three evidence boundaries. |
| Q10 | Open work and CPU-overhead evidence | PARTIAL | PASS | Native leaves CPU-overhead measurements unknown. The plugin explicitly preserves why local clock durations cannot satisfy that requirement. |
| Q11 | Plan continuation and authorization | PARTIAL | PARTIAL | Both preserve constrained next actions but omit the original completed step numbers. |
| Q12 | Revision and changed files | PASS | PASS | Both retain the original revision and both files. Revision equality was checked locally before redaction. |

The clearest differences were Q2 and Q10:

- Q2: native grouped missing, unsupported and unreadable metadata together. The plugin retained separate unavailable/unsupported/error outcomes, return-object identity and native-exception identity. That distinction matters when deciding whether a failure belongs to observation or to the native operation.
- Q10: native left CPU-overhead measurements unknown. The plugin retained the stronger boundary: no accepted CPU-overhead table existed, and local clock durations were insufficient evidence.

Both methods correctly replaced stale pending state with Succeeded, preserved numeric reference rows and negative controls, and retained limits on the next authorized action. Both omitted the literal ownership mapping, the 1.04s gate time and the original completed plan numbers. Neither recovered 11/384/[5,6]/16/PIECEWISE in Q3.

Q8 contains a source-label ambiguity: connecting narration calls 25 tests “recorder tests,” while the report identifies 25 affected tests without an independent recorder-only count. The plugin's unknown for the narrower count is recorded as cautious evidence handling. Both responses still miss the requested gate elapsed time, so both remain PARTIAL.

## Input coverage, usage and timing

Pi 1.3.0's native conversation serializer retained the first 2000 characters of each tool result before producing the summary request. The plugin submitted the full structured history in this case. Several exact test values and error rules were beyond the native truncation boundary. The plugin avoided that input loss, but full input did not guarantee exact recall: the five host values appeared in its request and were not recovered later. The responses alone cannot separate checkpoint loss from a recall failure.

A literal audit of the saved first requests confirmed the Q3 input difference:

| Source literal | Native compaction input | Plugin compaction input | Native / plugin recall |
| --- | --- | --- | --- |
| `num_actual_tokens=11` | Absent | Present | unknown / unknown |
| `prefill_max_seq_len=384` | Absent | Present | unknown / unknown |
| `local_sizes=[5, 6]` | Absent | Present | unknown / unknown |
| `num_tokens=16` | Absent | Present | unknown / unknown |
| `name='PIECEWISE'` | Absent | Present | unknown / unknown |

The last two literals belong to the batch descriptor and graph-mode object in the original test. Presence in a request does not prove retention in its checkpoint.

| Measurement | Pi native | Plugin |
| --- | ---: | ---: |
| First request input items | 2 | 53, including trigger |
| First request JSON bytes | 32,760 | 143,645 |
| Compaction service input tokens, including cache | 7,855 | 32,008 |
| Compaction service output tokens | 2,845 | 3,267 |
| Recall service input tokens, including cache | 4,288 | 5,779 |
| Recall request input items | 5 | 11, including one opaque item |
| Compaction wall time | 36.747s | 42.486s |
| Recall wall time, including retries | 60.026s | 35.762s |
| Visible summary characters | 8,349 | 278, notice only |
| Opaque encrypted-content characters | 0 | 20,388 |
| Pi estimatedTokensAfter | 4,770 | 2,752 |

Input tokens are the sum of input, cacheRead and cacheWrite returned by the provider. Output tokens use the returned output field; neither is an invoice or a measure of useful retained information.

The native recall received two 429 responses before succeeding; both plugin requests returned 200. Cache and generated output also differed. These wall times do not establish a repeatable speed advantage.

The plugin's 278-character summary is only a notice. Its real state includes retained user items and an opaque checkpoint. Pi's local after-estimate does not measure opaque tokenizer usage, so it cannot support a compression-ratio claim. In this case the plugin's measured recall input was larger, not smaller: 5,779 versus 4,288 tokens.

## Continued work after compaction

The saved Frontier plugin session was resumed and reloaded, then given a new progress turn larger than the recent window. A second genuine checkpoint completed in 31.983s. A 4.242s recall retained both the earlier fixture identifier and the new continuity marker.

A separate synthetic session completed first compaction, recall, normal new work, second compaction, reload and recall. Both checkpoints had fromHook=true. These checks show that the tested checkpoint path supports continued session work; they are not additional independent observations of the 12-question quality result.

## Limits and practical conclusion

This is one private engineering case, one artifact per method and one combined question response per artifact. There is no uncompressed full-context control, independent repeated probe, blinded reviewer or balanced execution order. The full private transcript and backend are not published, so the anonymized evidence packet allows inspection of answers and judgments but not an exact public live rerun. Identifier questions were checked locally against original literals before those identifiers were redacted.

The result supports a narrow practical conclusion: this plugin retained useful distinctions about failure handling and incomplete validation that native compaction omitted in this case. It did not preserve every exact parameter or plan index, and it did not reduce measured downstream context size. The study did not measure completed engineering tasks or the amount of rereading saved. Keep durable plans, test reports and source references, and reread exact values before using them to continue engineering work.
