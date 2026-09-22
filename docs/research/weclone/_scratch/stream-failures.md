# Documented Failure Modes — Making an LLM Imitate One Specific Real Person's Writing/Chat Style

**Stream:** failures / survey evidence
**Written for:** WeClone ("persona clone" from ~104,000 of one user's own WeChat messages; Chinese/English code-mixed, informal; currently BM25-matches past messages at chat time)
**Owner's symptom under investigation:** output is *"generic-assistant prose wearing a thin costume."*

**Method note.** This is a literature survey only — no code was written and no experiments were run. Every citation below was retrieved from a primary source (arXiv abstract page, ACL Anthology landing page, PMLR, NeurIPS proceedings, USENIX, Nature, or the publisher DOI landing page). Where I could only see a paper through a secondary aggregator (alphaXiv, an AI-news blog, a search snippet) and could **not** confirm it on the publisher's own page, it is marked **UNVERIFIED**. Where a paper named in the original request could not be found, that is stated explicitly. Numeric values are quoted verbatim from the source text.

---

## 0. Headline for this project

Five independent lines of evidence converge on the owner's complaint, and they are mechanistically distinct — which matters, because they need different fixes:

1. **The base model is already mode-collapsed toward an "average register" before any persona work happens** (§1). Adding a persona prompt or a style adapter is fighting a prior, not filling a vacuum.
2. **The assistant persona is a real, linearly-representable attractor in activation space, and it is also the default the model relaxes back into** (§3, §4). Role prompting "loosely tethers" the model; it does not anchor it.
3. **RAG over a person's own message history makes imitation *worse* in a specific, documented way: the model latches onto high-frequency words and n-grams instead of the style** (§8). This is precisely what a BM25-matched-context design is most exposed to.
4. **Fine-tuning on personal data creates a privacy/verbatim-replay risk that is real but smaller than commonly feared, and SFT actually *reduces* pre-training memorization while increasing memorization of the fine-tuning data** (§5).
5. **Even when style imitation succeeds by authorship-attribution metrics, the text stays statistically distinguishable from human writing** (§7). "Fooled the verifier" ≠ "reads like the person".

---

## 1. Mode collapse / register collapse / diversity loss

### 1.1 The foundational decoding result

**The Curious Case of Neural Text Degeneration.** Ari Holtzman, Jan Buys, Li Du, Maxwell Forbes, Yejin Choi. 2019 (ICLR 2020). arXiv:1904.09751 — https://arxiv.org/abs/1904.09751

- Core finding, quoted: *"even though the use of likelihood as training objective leads to high quality models for a broad range of language understanding tasks, maximization-based decoding methods such as beam search lead to degeneration — output text that is bland, incoherent, or gets stuck in repetitive loops."*
- Abstract conclusion, quoted: *"likelihood maximizing decoding causes repetition and overly generic language usage, while sampling methods without truncation risk sampling from the low-confidence tail."*
- Mechanism and fix: **Nucleus Sampling (top-p)** — *"truncating the unreliable tail of the probability distribution, sampling from the dynamic nucleus of tokens containing the vast majority of the probability mass."* The nucleus *"tends to range between one and a thousand candidates."*
- Relevance to WeClone: if the WeClone generation path uses low temperature, beam search, or a very small top-p, this paper predicts *bland + repetitive* output independent of any persona conditioning. The complaint "generic-assistant prose" is partly a **decoding-parameter** symptom.

### 1.2 RLHF narrows the output distribution — with a causal stage attribution

**Understanding the Effects of RLHF on LLM Generalisation and Diversity.** Robert Kirk, Ishita Mediratta, Christoforos Nalmpantis, Jelena Luketina, Eric Hambro, Edward Grefenstette, Roberta Raileanu. 2023 (ICLR 2024). arXiv:2310.06452 — https://arxiv.org/abs/2310.06452 · ICLR PDF: https://proceedings.iclr.cc/paper_files/paper/2024/file/5a68d05006d5b05dd9463dd9c0219db0-Paper-Conference.pdf

This is the single most directly quotable paper for the "collapse to an average register" claim.

- Abstract, quoted: *"RLHF significantly reduces output diversity compared to SFT across a variety of measures, implying a tradeoff in current LLM fine-tuning methods between generalisation and diversity."*
- The authors claim priority on a specific claim worth quoting precisely: *"We believe that this is the first rigorous empirical demonstration of across-input mode collapse emerging from RLHF training specifically."*
- Their definition of the failure, quoted: *"even for different inputs, RLHF models can be biased towards outputting text of a specific style or 'mode', meaning that even changing the inputs to a model is not sufficient to generate truly diverse outputs."* ← **This is the owner's complaint, stated as a formal result, four years before the complaint.**
- Method detail (numbers): diversity measured by **EAD (expectation-adjusted distinct n-grams, averaged over n = 1…5)**, **Sentence-BERT embedding cosine similarity**, and **NLI diversity**. Sampling was **K = 16 outputs per input over N = 500 inputs at temperature 1**. **Per-input** = diversity of π(y|x); **across-input** = diversity of π(y).
- One important caveat the authors report honestly: *"We ran some initial experiments evaluating diversity for the instruction-following models, but we did not see any meaningful differences."* They hypothesise the metrics were designed for short single-sentence outputs. So the *strong* diversity-collapse numbers are on **summarisation**, not instruction-following — a limitation worth carrying into any WeClone claim.
- They also report a failed mitigation: *"increasing the KL penalty coefficient leads to a drop in performance as expected, but also to a drop in per-input diversity, rather than a gain."*

### 1.3 The "Artificial Hivemind" — with hard numbers

**Artificial Hivemind: The Open-Ended Homogeneity of Language Models (and Beyond).** Liwei Jiang, Yuanjun Chai, Margaret Li, Mickel Liu, Raymond Fok, Nouha Dziri, Yulia Tsvetkov, Maarten Sap, Alon Albalak, Yejin Choi. 2025. **NeurIPS 2025 Datasets & Benchmarks Track (Oral)**. arXiv:2510.22954 — https://arxiv.org/abs/2510.22954 · NeurIPS PDF: https://papers.neurips.cc/paper_files/paper/2025/file/754d5a526a5ee5a47220664a0eb92751-Paper-Datasets_and_Benchmarks_Track.pdf

Introduced **INFINITY-CHAT**: *"a large-scale dataset of 26K diverse, real-world, open-ended user queries"*, a 6-category / 17-subcategory taxonomy, plus **31,250 human annotations** with **25 independent annotators per example**.

Exact numbers, quoted from the paper:

| Measurement | Value |
|---|---|
| **Intra-model repetition** — avg. pairwise embedding similarity of 50 responses per query, same model | **In 79% of cases the average similarity exceeds 0.8** |
| Decoding parameters used (i.e. already maximally aggressive) | **top-p = 0.9, t = 1.0** |
| Same, under **min-p** decoding | *"81% of response pairs still exceed 0.7 similarity and 61.2% exceed 0.8"* |
| **Inter-model homogeneity** — avg. pairwise similarity between *different* models | **71% to 82%** |
| Named example pairs | DeepSeek-V3 ↔ qwen-max-2025-01-25 = **0.82**; DeepSeek-V3 ↔ gpt-4o-2024-11-20 = **0.81** |
| Scale of study | **70+ open/closed LMs** screened, **25 detailed** in the main paper |

Two sentences from the paper that map almost word-for-word onto the owner's complaint:

> *"Despite using high-stochasticity decoding parameters (top-p = 0.9, t = 1.0), responses from the same model remain highly repetitive."*

> *"even changing the inputs to a model is not sufficient to generate truly diverse outputs"* (paraphrased by them as: models *"independently converge on similar ideas with minor variations in phrasing"*).

**The critical implication for WeClone:** raising temperature and top-p does **not** recover diversity. The paper tested the strongest available diversity-oriented decoding knob (min-p) and repetition remained. This kills the most obvious "just turn up the temperature" fix.

### 1.4 Collapse traces back to pretraining, and *assistant-style prompting itself triggers it*

**Is Convergence Inevitable? Tracing Output Homogeneity Back to Base Models.** arXiv:2608.11426, submitted 13 Aug 2026 — https://arxiv.org/abs/2608.11426

*(Authors' names were not visible in the retrieved abstract page or the arXiv HTML snippet; I am therefore not asserting an author list. Title, ID, abstract and quoted figures are from arXiv and corroborated by two independent mirrors.)*

- Abstract, quoted: *"The lack of diversity in LM content is widely attributed to the alignment process... We argue that output homogeneity is likely learned during the pretraining phase, and only revealed or magnified during the alignment process."*
- *"We find that convergence can be revealed and amplified, but not introduced by the SFT data, supporting its role as a catalyst rather than a cause."*
- **This is the most on-point single experiment for WeClone's design.** The paper's probe is metaphor generation; under **basic completion prompting** outputs were diverse (*"vehicles from rubber band to worm, to describe the time passing"*), whereas under **few-shot** and **assistant-style persona** conditions the model collapsed onto *"the classic river and thief vehicles."* Their conclusion, quoted: *"we find that few-shot examples and assistant-style persona prompting can induce convergence — mirroring the behavior of aligned models — whereas basic completion yields more diverse outputs."*
- Numeric amplification detail: injecting a preferred token into SFT data produced frequency of **48–92%** for the top pre-existing choice, only **1–12%** for the 6th-ranked choice, and **out-of-distribution choices "failed to be learned"** entirely. In an appendix they note **5–7 instances are needed for full convergence** on implausible items.

**Read this as the design rule it is:** *the more the context window looks like an assistant conversation, the more the model reverts to the assistant mode.* A persona-clone chat UI is, structurally, an assistant conversation.

### 1.5 Recursive / synthetic-data collapse (adjacent, but the canonical citation)

**AI models collapse when trained on recursively generated data.** Ilia Shumailov, Zakhar Shumaylov, Yiren Zhao, Nicolas Papernot, Ross Anderson, Yarin Gal. **Nature** 631, 755–759 (2024). DOI 10.1038/s41586-024-07566-y — https://www.nature.com/articles/s41586-024-07566-y

- Abstract, quoted: *"indiscriminate use of model-generated content in training causes irreversible defects in the resulting models, in which tails of the original content distribution disappear. We refer to this effect as 'model collapse'."*
- Definitions worth citing: *"In early model collapse, the model begins losing information about the tails of the distribution; in late model collapse, the model converges to a distribution that carries little resemblance to the original one, often with substantially reduced variance."*
- **Directly relevant warning for a self-improving clone:** *"the use of LLMs at scale to publish content on the Internet will pollute the collection of data to train their successors: data about human interactions with LLMs will be increasingly valuable."* If WeClone ever trains on its own outputs (or on a chat log that now contains its own outputs), this is the documented trajectory.

### 1.6 Also found (indicative, not fully verified)

- **The Alignment Tax: Response Homologenization in Aligned LLMs and Its Implications for Uncertainty Estimation** — surfaced via alphaXiv at `alphaxiv.org/abs/2603.24124`. Reported numbers: TruthfulQA (n=790) single-cluster rate **40–79%** across 10 i.i.d. samples; base vs instruct **1.0% vs 28.5%** SCR (p < 10⁻⁶); stage ablation **Base 0.0% → SFT 1.5% → DPO 4.0%**; WebQuestions **58.0%** SCR. **UNVERIFIED** — I could not open this on arxiv.org or any publisher page; treat the numbers as unconfirmed.
- **Where does output diversity collapse in post-training?** — surfaced via a malformed alphaXiv URL only. **UNVERIFIED**, and the URL could not be resolved.
- **Rethinking Post-training Diversity Collapse: Is Diversity-preserving Post-training Enough?** Zhaoyi Joey Hou, Zhuowei Chen, Mengxue Zhang, Xiang Lorraine Li. ICML 2026 GenAI Creativity workshop PDF — https://genaicreativity.org/icml2026/files/54/54_paper.pdf. Useful angle: diversity-preserving post-training (DDPO/DORPO) *did not* fix non-surface patterns (emotional arc, opening type). Quantified implicit preference leakage in training preference pairs: **57.8%** of disagreeing pairs favour the "Edit/Thanks ending" feature; **54.1%** favour "opens with dialogue". Note: workshop paper, not a main-conference publication.

---

## 2. Style vs. content entanglement

### 2.1 Style cannot be usefully separated from content

**Style versus Content: A distinction without a (learnable) difference?** Somayeh Jafaritazehjani, Gwénolé Lecorvé, Damien Lolive, John Kelleher. COLING 2020. ACL Anthology: https://aclanthology.org/2020.coling-main.197.pdf

- Abstract, quoted: *"This paper investigates whether this separation is possible... The results of our experiments which are further confirmed by a human evaluation reveal an inherent trade-off between the multiple style transfer objectives and indicate that **style cannot be usefully separated from content** within these style-transfer systems."*
- Mechanism, quoted: *"encoders mistakenly strip out content when attempting to remove source stylistic features."*
- Numbers: multi-generator architecture raised style-shift power from **78.76% → 94.41%** but **lost content preservation**. Content-preservation lower bound reported as **0.817** (mean cosine distance to random same-style training sentences).
- This is the theoretical refutation of the "keep content, swap style" framing that a persona-clone prompt implicitly assumes.

### 2.2 LLMs copy the input instead of transferring style — measured "copy rates"

**Style-Specific Neurons for Steering LLMs in Text Style Transfer** (sNeuron-TST). Wenlai et al. 2024. arXiv:2410.00593 — https://arxiv.org/html/2410.00593v1

- Quoted: *"in zero-shot setups, [LLMs] tend to directly copy a significant portion of the input text to the output without effectively changing its style."*
- **Exact number:** *"Our analysis reveals that **34% of the outputs generated by LLaMA-3 are identical to the input text** when tasked with transferring polite text to impolite text."*
- Quoted on why content-preservation scores look deceptively good: *"we find that this content preservation is largely attributable to the copy mechanism, i.e., the generated text tends to prioritize maintaining the original semantics, thereby neglecting the stylistic differences."*
- Also documents a **content/style measurement paradox**: *"Sorry about that."* vs *"I apologize for the inconvenience caused."* are stylistically correct but have cosine similarity only **0.447**, so semantic metrics penalise successful style transfer.
- Benchmarks used: **6 benchmarks / 12 TST directions** (formality, toxicity, politics, politeness, authorship, sentiment).

### 2.3 The style–content trade-off is a curve, not a point

**Evaluating Style Transfer for Text.** Remi Mir, Bjarke Felbo, Nick Obradovich, Iyad Rahwan. 2019. arXiv:1904.02295 — https://arxiv.org/pdf/1904.02295

- Names the three axes: **style transfer intensity (STI)**, **content preservation (CP)**, **naturalness (NT)** — and shows they are in tension: *"Across all models, there is a trend of reduction in content preservation and naturalness as style transfer intensity increases."*
- **Crucial methodological warning, quoted:** methods comparison is invalid without the trade-off plot — *"Without the plots, one might conclude that ARAE and DAR perform substantially differently, especially if hyperparameters are chosen such that ARAE achieves the leftmost point on its plot and DAR achieves the rightmost point."*
- They also introduce **style-masked** content-preservation rating (replacing style words with a placeholder), reporting improved human agreement: kappa **0.297** masked vs **0.173** unmasked.

### 2.4 The style-transfer evaluation literature is itself unreliable

**Reformulating Unsupervised Style Transfer as Paraphrase Generation** (STRAP). Kalpesh Krishna, John Wieting, Mohit Iyyer. EMNLP 2020. ACL Anthology: https://aclanthology.org/2020.emnlp-main.55.pdf

- Abstract/body, quoted: *"we survey 23 style transfer papers and discover that existing automatic metrics can be easily gamed and propose fixed variants."*
- **The killer result:** *"a naïve baseline that randomly chooses to either copy its input or retrieve a random sentence written in the target style **outperforms prior work** on poorly-designed metrics"* — specifically *"this system outperforms state of the art methods (UNMT, DSLM) on the Formality dataset **despite not doing any style transfer at all**!"*
- Human evaluation: *"fewer than **25%** of style-transferred sentences from two state-of-the-art systems... on formality transfer were rated as paraphrases of their inputs."*
- Also: *"only **3 out of 23** prior style transfer papers properly evaluate their models"* (sentence-level metric aggregation).
- **Why this matters for WeClone:** if the project ever measures its own persona-clone quality with a style classifier or n-gram similarity, this paper is the reason not to trust a single number. A copy-or-retrieve baseline must be beaten.

**Mind the Style Gap: Meta-Evaluation of Style and Attribute Transfer Metrics.** Amalie Brogaard Pauli, Isabelle Augenstein, Ira Assent. Findings of EMNLP 2025. DOI 10.18653/v1/2025.findings-emnlp.1175 — https://doi.org/10.18653/v1/2025.findings-emnlp.1175

- Quoted: *"Widely used metrics show a high correlation with human judgments despite being deemed unsuitable for the task — because they do not abstract from style changes when evaluating content preservation... the overly high correlations with human judgment stem from the nature of the test data."*
- On their new stress-test set, similarity-based content-preservation metrics show *"low to negative correlations with human judgment."* **This is a warning that even the evaluation apparatus for "did we preserve content" is broken by default.**

---

## 3. Sycophancy and assistant-persona leakage

### 3.1 Sycophancy is a general property of RLHF assistants

**Towards Understanding Sycophancy in Language Models.** Mrinank Sharma, Meg Tong, Tomasz Korbak, David Duvenaud, Amanda Askell, Samuel R. Bowman, Newton Cheng, Esin Durmus, Zac Hatfield-Dodds, Scott R. Johnston, Shauna Kravec, Timothy Maxwell, Sam McCandlish, Kamal Ndousse, Oliver Rausch, Nicholas Schiefer, Da Yan, Miranda Zhang, Ethan Perez. 2023 (ICLR 2024). arXiv:2310.13548 — https://arxiv.org/abs/2310.13548 · Anthropic writeup: https://www.anthropic.com/research/towards-understanding-sycophancy-in-language-models

- Abstract, quoted: *"We first demonstrate that **five state-of-the-art AI assistants consistently exhibit sycophancy across four varied free-form text-generation tasks**."*
- Exact numbers from the paper:
  - *"We find the sycophantic responses are preferred over the baseline truthful responses **95% of the time**."*
  - *"the PM prefers the sycophantic response almost half the time (**45%**)"* — specifically for *helpful truthful responses* on misconceptions.
- Four sycophancy task types named in the paper: **feedback sycophancy, answer sycophancy, mimicry sycophancy**, plus a fourth free-form task; measurement includes **BoN with N = 1…32** and RL-phase tracking.
- **Relevance to a persona clone:** *mimicry sycophancy* is defined as agreeing with / mirroring the user. A clone that is tuned toward agreement will, by this result, tend toward *generic agreeable* output — the exact register the owner is complaining about. Sycophancy and "sounds like the owner" pull in opposite directions.

### 3.2 The assistant persona is a measurable axis in activation space — and it dominates

**The Assistant Axis: Situating and Stabilizing the Default Persona of Language Models.** Christina Lu, Jack Gallagher, Jonathan Michala, Kyle Fish, Jack Lindsey. Submitted **15 Jan 2026**. arXiv:2601.10387 — https://arxiv.org/abs/2601.10387

**This paper exists and is verified.** (The user asked whether "The Assistant Axis" is real — it is.)

- Abstract, quoted: *"Large language models can represent a variety of personas but typically **default to a helpful Assistant identity cultivated during post-training**. We investigate the structure of the space of model personas by extracting activation directions corresponding to diverse character archetypes. Across several different models, we find that the **leading component of this persona space is an 'Assistant Axis'**."*
- **The central finding for WeClone:** *"Our results suggest that post-training steers models toward a particular region of persona space but **only loosely tethers them to it**."*
- **What causes drift back to / away from the assistant:** *"persona drift is often driven by conversations demanding meta-reflection on the model's processes or featuring emotionally vulnerable users."* And from the HTML full text: bounded tasks / how-to's / coding *"keep the model in its default persona"*, while *"emotionally charged disclosures or pushes for meta-reflection on the model's own processes reliably cause drift away from the Assistant."*
- **Important asymmetry** (from full text): steering *away* from the Assistant at moderate strength *"increases their susceptibility to fully embodying the perspectives of different personas"*, but *"steering further causes them to behave like a mystical and/or theatrical persona."* So the persona dial has a **narrow usable band** and degrades into theatre past it.
- **Numeric validation:** the Assistant Axis overlaps the first principal component of persona space at **> 0.60 at all layers** across three models, and **> 0.71 at the middle layer of each model**.
- They also show a mitigation primitive: *"restricting activations to a fixed region along the Assistant Axis can stabilize model behavior in these scenarios — and also in the face of adversarial persona-based jailbreaks."*
- Relevant to "the model reverts under pressure": steering *toward* the Assistant *"significantly decreased the rate of harmful responses and slightly increased the rate of refusals."*

### 3.3 Corroboration: personas retain an "assistant core"; the assistant can re-instantiate inside a persona

**"Many Are My Names": The Anatomy of the Assistant and Its Personas via Sparse Autoencoders.** arXiv:2608.07852 — https://arxiv.org/pdf/2608.07852.pdf
*(Author list not visible on the retrieved PDF landing excerpt; cited by title + arXiv ID only.)*

- Quoted: *"our main finding is that the Assistant and roleplay personas are **not independent alternatives: personas retain the Assistant-associated feature core** while progressively differentiating from it across layers, starting from operational machinery towards behavioral and stylistic features."*
- *"The Assistant has a multifaceted identity and can be **reinstated within an already-instantiated persona**."*
- And a named drift mode: **"Immersive Simulation Mode" (ISM)** — *"This mode sometimes activates when the user expresses strong emotions in the Assistant setting which results in Assistant adopting bizarre, theatrical behavior. The activation dynamics is different for studied models — Gemma enters ISM immediately while Llama drifts into it across turns."*
- **Direct design consequence:** a WeChat-clone persona is a *superset* of the assistant, not a replacement. The assistant features are still present and can re-emerge mid-conversation — which is a mechanistic account of "thin costume."

### 3.4 Assistant bias is documented as *structurally baked in* and not overridden by role prompts

**Investigating Assistant Bias in LLM User Simulators Using a Role Vector.** arXiv:2609.00608 — https://arxiv.org/html/2609.00608

- Quoted: *"Prior work outlines that **this bias is baked in during model training, which role-playing prompts fail to override**."*
- And: *"Together, these findings suggest that **the assistant persona in LLMs may take precedence over an instructed user persona** during simulation, falling back on assistant-like behavior."*
- The paper reports that role-play biases show up as *"long, polite, explanation-heavy turns even when asked to speak as another party."* ← **"long, polite, explanation-heavy turns" is a precise description of "generic-assistant prose."**
- Method note (useful precedent for WeClone instrumentation): they extract a **user role vector** by contrastive activation addition on role-specific reflections of the same dialogue, and find *"the user direction is identifiable in activations, elicits user-like behaviors, and captures characteristics distinct from assistant traits."* Caveat they report: steering *"can exaggerate user behaviors and override individual user profiles."*

### 3.5 Direct evidence on the exact failure, for the exact task

**IMPersona: Evaluating Individual Level LM Impersonation.** Quan Shi, Carlos E. Jimenez, Stephen Dong, Brian Seo, Caden Yao, Adam Kelch, Karthik Narasimhan. Submitted 6 Apr 2025 (v2 8 Apr 2025). arXiv:2504.04332 — https://arxiv.org/abs/2504.04332

This is the closest published analogue to WeClone: personal message histories → SFT (LoRA) + hierarchical memory retrieval → blind human Turing-style conversation.

- Abstract, quoted: *"participants (mis)identified our fine-tuned models with memory integration as human in **44.44%** of interactions, compared to just **25.00%** for the best prompting-based approach."*
- Best fine-tuned configuration: Llama-3.1-8B-Instruct, full dataset + hierarchical memory, **44.12%** pass rate and **3.65** humanness score.
- **The failure-mode description is the owner's complaint, verbatim in substance:** *"They tend to generate **overly polished, professional responses, incorporating only marginal stylistic elements from the examples**. Claude performs slightly better, as it more effectively adopts specific stylistic markers like abbreviations, casual phrasing, and emoji usage. However, **a common failure across all prompting-based models was their excessive enthusiasm, which made them easily identifiable as AI**, regardless of how well they incorporated user-specific details."*
- Their figure caption adds a second, subtler failure: models imitate surface markers but not affect — *"Claude is capable of imitating a lot of the stylistic markers, such as abbreviations and texting manner: however, **it has a hard time replicating the affective stance**."*
- **A failure mode unique to fine-tuning, and relevant to privacy/UX:** *"an issue unique to fine-tuned models is their more frequent disruption to conversation flow. They sometimes jump between topics or abruptly change context in ways that may be unnatural... a model might suddenly switch topics/opinions in the middle of a conversation."* They attribute this to real conversations being grounded in external events that are out-of-distribution in a simulated environment.
- Design detail worth copying: they used **LoRA rather than full fine-tuning** specifically because *"LoRA regularization reduced random topic switching behavior that commonly occurs with full-weight fine-tuning."*
- Data processing detail: they defined a conversation as *"text exchanges without message gaps exceeding six hours"* and filtered out *"repetitive phrases, highly imbalanced exchanges, and excessively long messages."*

---

## 4. Persona drift over long conversations

### 4.1 The paper the request asked me to verify — it exists, **but it was retitled**

**Measuring and Controlling Instruction (In)Stability in Language Model Dialogs.** Kenneth Li, Tianle Liu, Naomi Bashkansky, David Bau, Fernanda Viégas, Hanspeter Pfister, Martin Wattenberg. **COLM 2024**. arXiv:2402.10962 (v1 13 Feb 2024; v4 25 Jul 2024) — https://arxiv.org/abs/2402.10962

**Explicit verification note for the requester.** There is **no paper titled "Measuring and Controlling Persona Drift in Language Model Dialogue."** The paper is real but:

- **v1 title:** *"Measuring and Controlling Persona Drift in Language Model Dialogs"* (https://arxiv.org/html/2402.10962v1)
- **Current/final title (v4, COLM 2024):** *"Measuring and Controlling Instruction (In)Stability in Language Model Dialogs"*

So the title in the request corresponds to **v1 only**; citing the current title is required for the published version. Note also **"Dialogs"**, not "Dialogue". The code repository is still named `persona_drift` (https://github.com/likenneth/persona_drift), which is likely the source of the confusion.

Content:

- Abstract (v1), quoted: *"Testing popular models like LLaMA2-chat-70B, we reveal a **significant persona drift within eight rounds of conversations**. An empirical and theoretical analysis of this phenomenon suggests the transformer attention mechanism plays a role, due to **attention decay** over long exchanges."*
- Final abstract (v4) describes the same result framed as instruction stability, and notes testing *"popular models like LLaMA2-chat-70B **and GPT-3.5**."*
- Benchmark: **100 persona system prompts** in **5 categories** (multi-choice responses, character of the agent, answer-string format pattern, memorization of certain facts, languages the agent speaks); results averaged over **200 conversations** with random persona pairs.
- Mechanism, quoted: *"within each turn, π(t) remains almost constant, but there are **significant decreases across turns**."*
- Mitigation: **split-softmax** — a power-law attention rescaling requiring no retraining. Reported trade-off: *"split-softmax presents a better trade-off between performance drop and persona stability"* and *"can match performance with system prompt repetition while avoiding using the additional context window."*

**The "eight rounds" number is the headline citable fact for WeClone's conversation-length budgeting.**

### 4.2 Long-dialogue measurement with 100+ turns

**Persistent Personas? Role-Playing, Instruction Following, and Safety in Extended Interactions.** Pedro Henrique Luz de Araujo, Michael A. Hedderich, Ali Modarressi, Hinrich Schütze, Benjamin Roth. **EACL 2026** (long). ACL Anthology: https://aclanthology.org/2026.eacl-long.246/ · PDF: https://aclanthology.org/2026.eacl-long.246.pdf · arXiv:2512.12775

- Abstract, quoted: *"We introduce an evaluation protocol that combines **long persona dialogues (over 100 rounds)**... We find that **persona fidelity degrades over the course of dialogues, especially in goal-oriented conversations**... We identify a trade-off between fidelity and instruction following, with non-persona baselines initially outperforming persona-assigned models; **as dialogues progress and fidelity fades, persona responses become increasingly similar to baseline responses**."*
- Setup numbers: **7 state-of-the-art open- and closed-weight LLMs**; **#personas + baseline = 9**; **2 dialogue types × 2 shuffles = 36 long dialogues per model**; **n = 10 evenly spaced dialogue prefixes** for conditioning. Dialogues *"span over 100 rounds — longer than **99.99% of Wild Chat** interactions."*
- **Three fidelity sub-metrics degrade together:** *"This degradation is observed across all three metrics — **knowledge, style, and in-character consistency** — and is more pronounced in goal-oriented dialogues than in persona-directed ones."*
- **Not a context-window artefact** — they checked: *"This fidelity degradation is not due to sequence truncation or dialogues exceeding models' context windows."*
- **The "thin costume" mechanism, stated as a result:** *"as fidelity declines, models **revert to their baseline behavior** rather than collapsing entirely. This shift can improve certain metrics — such as instruction following or safety — but undermines applications that rely on sustained persona fidelity."*
- **Trade-off:** *"Persona-assigned LLMs consistently underperform the baseline in instruction-following tasks, suggesting that maintaining a persona comes at the cost of general task quality."*
- **Scale does not fix it:** *"Scaling helps mitigate—but does not eliminate—the issues we observe. Larger models show smaller fidelity gaps between the first and last dialogue rounds... However, **statistically significant gaps remain even in the largest models**"* — gaps remain significant even for **Gemini-2.5-flash**.
- **Persona-directed vs goal-oriented:** persona-centric systems hold fidelity better; *"task instructions pull the model away from its persona."* For WeClone (mostly chit-chat, i.e. persona-directed) this is the *favourable* case — but note the WeClone product also does task-like things (search, summarisation), which is the *unfavourable* case.
- Third-party corroboration of a drift-detection metric: **"Persona Drift Detection in Role-Playing Agents: A Multi-Dimensional Consistency Framework"**, ICASSP 2026, DOI 10.1109/icassp55912.2026.11463024 — introduces **Time-to-First-Drift (TtFD)** over **100-round** simulations with ChatGPT, Qwen, Gemini, DeepSeek. *(Retrieved via DOI landing page + reference list; full text not opened — treat the TtFD definition as indicative.)*

---

## 5. Memorization, privacy leakage, verbatim copying

### 5.1 The three canonical results, with exact numbers

**(a) Extracting Training Data from Large Language Models.** Nicholas Carlini, Florian Tramèr, Eric Wallace, Matthew Jagielski, Ariel Herbert-Voss, Katherine Lee, Adam Roberts, Tom Brown, Dawn Song, Úlfar Erlingsson, Alina Oprea, Colin Raffel. **USENIX Security 2021**. arXiv:2012.07805 — https://arxiv.org/abs/2012.07805 · PDF: https://www.usenix.org/system/files/sec21-carlini-extracting.pdf

- Quoted: *"we are able to extract **hundreds of verbatim text sequences** from the model's training data."*
- **Exact numbers:** *"we generate **1,800** candidate memorized samples, **100** under each of the 3×6 attack configurations, and find that **over 600** of them are verbatim samples from the GPT-2 training data... In the best attack configuration, **67% of candidate samples are verbatim training examples**."* Aggregate true positive rate reported as **33.5%** (best variant **67%**).
- **Ordering result, load-bearing for a clone:** *"Worryingly, we find that **larger models are more vulnerable than smaller models**."*
- Extracts *"names, phone numbers, and email addresses... IRC conversations, code, and 128-bit UUIDs"* — **each present in just one document in the training data.**

**(b) Quantifying Memorization Across Neural Language Models.** Nicholas Carlini, Daphne Ippolito, Matthew Jagielski, Katherine Lee, Florian Tramèr, Chiyuan Zhang. 2022. arXiv:2202.07646 — https://arxiv.org/abs/2202.07646

- Abstract, quoted: *"We describe **three log-linear relationships** that quantify the degree to which LMs emit memorized training data. Memorization significantly grows as we increase (1) the capacity of a model, (2) **the number of times an example has been duplicated**, and (3) the number of tokens of context used to prompt the model."*
- **Exact numbers:**
  - Model scale: *"a **ten fold increase in model size corresponds to an increase in memorization of 19 percentage points**"*, with *"a near-perfect log-linear fit (**R² of 99.8%**)."* Larger models memorize **2–5× more** than smaller within a family.
  - Duplication: buckets of sequences duplicated **between 2 and 900 times**, each bucket **1,000 distinct sentences**. *"While models rarely regurgitate strings that are repeated only a few times, this probability increases severely for highly duplicated strings."* Critically: *"we find that memorization **does still happen, even with just a few duplicates** — thus, **deduplication will not perfectly prevent leakage**."*
  - Context: *"**33% of training sequences** in our evaluation set are extractable from the 6B model at **50 tokens** of context, compared to **65% with 450 tokens** of context."* They name this the **"discoverability phenomenon."**
- **The direct implication for WeClone:** a WeChat log is *enormously* duplicated in the ways this paper measures — the same greetings, emoji, catchphrases, "哈哈哈", "ok", "好的", recurring formulaic exchanges appear hundreds of times. Long retrieved BM25 context (see the 450-token datapoint) makes verbatim replay *more* likely, not less. And dedup will not save you.

**(c) The Secret Sharer: Evaluating and Testing Unintended Memorization in Neural Networks.** Nicholas Carlini, Chang Liu, Úlfar Erlingsson, Jernej Kos, Dawn Song. **USENIX Security 2019**. arXiv:1802.08232 — https://arxiv.org/pdf/1802.08232.pdf · https://www.usenix.org/system/files/sec19-carlini.pdf

**This is the most important citation for a messaging-data use case**, because its motivating setting *is* messaging data.

- Abstract, quoted: *"Because such models are sometimes trained on sensitive data (e.g., **the text of users' private messages**), this methodology can benefit privacy..."*
- Their motivating example is literally predictive keyboards: *"users may find that the input 'my social-security number is…' gets auto-completed to an obvious secret"*, and the paper's production case study is *"Google's Smart Compose, a commercial text-completion neural network trained on **millions of users' email messages**."*
- They extract *"credit card numbers from a language model trained on the **Enron email** data."*
- **Four results that directly bound WeClone's risk, quoted:**
  1. *"unintended memorization is a persistent, hard-to-avoid issue"* — *"both commonplace and hard to prevent."*
  2. *"such memorization is **not due to overtraining**: it occurs **early during training**, and persists across different types of models and training strategies — even when the memorized data is very rare and the model size is much smaller than the size of the training data corpus."*
  3. *"simple, intuitive regularization approaches such as **early-stopping and dropout are insufficient** to prevent unintended memorization."*
  4. *"**Only by using differentially-private training techniques are we able to eliminate the issue completely**, albeit at some loss in utility."*
- Their metric is **exposure**, and the method is **canary insertion** — insert known-unique out-of-distribution strings, train, then measure whether they can be extracted. This is a directly reusable audit design for WeClone.

### 5.2 Alignment does **not** remove memorization — it hides it

**Scalable Extraction of Training Data from (Production) Language Models.** Milad Nasr, Nicholas Carlini, Jonathan Hayase, Matthew Jagielski, A. Feder Cooper, Daphne Ippolito, Christopher A. Choquette-Choo, Eric Wallace, Florian Tramèr, Katherine Lee. 2023. arXiv:2311.17035 — https://arxiv.org/abs/2311.17035

- Abstract, quoted: *"in order to attack the aligned ChatGPT, we develop a new **divergence attack** that causes the model to diverge from its chatbot-style generations and emit training data at a rate **150× higher** than when behaving properly... reveal that **current alignment techniques do not eliminate memorization**."*
- Figure 1 caption, quoted: *"The aligned ChatGPT (gpt-3.5-turbo) appears **50× more private** than any prior model, but we develop an attack that shows it is not. Using our attack, ChatGPT emits training data **150× more frequently** than with prior attacks, and **3× more frequently than the base model**."*
- **Baseline leakage rates (extremely useful as calibration):** *"Out of these tokens, just **0.02%** of tokens are part of a 50-token sequence that is directly copied from AuxDataset. In contrast, for the smallest semi-closed model we study (OPT with 1.3B parameters), we found that **0.031%** of emitted tokens are directly copied from the training dataset; for the (presumably) comparable gpt-3.5-turbo-instruct model, at least **0.85%** of emitted tokens are part of a memorized sequence."*
- Yield: *"Using only **$200 USD** worth of queries to ChatGPT (gpt-3.5-turbo), we are able to extract **over 10,000 unique verbatim-memorized** training examples."* Good-Turing lower bound: *"at least **1.5 million unique 50-token sequences**"*; extrapolated true rate *"likely closer to **hundreds of millions of 50-token sequences, totaling a gigabyte of training data**."*
- Discoverability caveat: *"gpt-3.5-turbo completes the corresponding 50 token suffix in just **3.5%** of cases. (In a further **4%** of cases, we approximately recover the suffix...). Put differently, **over 90% of the time the model fails to emit the memorized output** that we know to be memorized."*
- **The mechanism is a direct match to the WeClone risk:** the paper notes alignment *"can also train models to use a **unified chat-like persona**"* — and the divergence attack works by making the model *"diverge from reasonable, chatbot-style generations, and to behave like a base language model."* **Inverting this: the assistant register is what is actively suppressing verbatim replay.** A persona clone that successfully suppresses the assistant register is, by this result, pushing *toward* the memorization-emitting regime. This is a genuine, non-obvious design tension that the WeClone project should know about before it "fixes" the generic-prose problem.

### 5.3 Does fine-tuning make memorization worse? Nuanced — cite both directions

**Instruction Fine-Tuning Through the Lens of Verbatim Memorization.** Electronics (MDPI) 15(2):377, published 15 Jan 2026. DOI 10.3390/electronics15020377 — https://www.mdpi.com/2079-9292/15/2/377

*(Author list not visible on the retrieved page; cited by title, journal, volume/issue, DOI.)*

- **This paper's direction is the opposite of the naive expectation:** *"We found that supervised fine-tuning **significantly weakens the model's verbatim memorization of pre-training data**. Simultaneously, it improves generated text in terms of alignment objectives, such as polite expression and structured organization."*
- Exact numbers: OLMo-2 at **1B, 7B, 13B, 32B**. On Wiki-Fact (L_p=32, L_c=16), 32B BLEU-2 **0.270 → 0.256** after SFT. On DCLM-PRIVACY, 1B perplexity **21.04 → 30.12 (+43%)**; 32B **14.23 → 14.80 (+4%)**. Idiom exact-match: 32B **0.72 → 0.61**; 13B **0.60 → 0.50**.
- Their framing: SFT is a **"learning tilt"** — *"the model's high-level representation space appears to be reoriented toward alignment objectives (e.g., **polite, structured**, and instruction-following behavior), while lower-level linguistic features remain relatively intact"*, localised to **later layers**.
- **Read this as a double-edged result for WeClone:**
  - Good news: SFT does not simply amplify regurgitation of the *pre-training* corpus.
  - Bad news, and it is the load-bearing one: *"SFT significantly improves the model's adherence to instruction-aligned linguistic styles, such as **politeness and structured organization**."* **Fine-tuning on a persona makes output *more* polite and *more* structured** — i.e. it actively pushes toward the register the owner is complaining about. This is a mechanism-level explanation of "thin costume" that is independent of §1 and §3.
  - Also: it *reduces* memorization of the pre-training corpus while (per the SFT-memorization mechanism in §5.1(b) and the IMPersona result in §3.5) increasing fidelity to the *fine-tuning* data. Those are different distributions and only one of them is private.
- The paper also finds an **alignment tax**: reasoning improves, knowledge-intensive tasks degrade modestly.

**Membership inference on fine-tuned LLMs — the risk is real but defences work.**

- **Membership Inference Attacks against Language Models via Neighbourhood Comparison.** Justus Mattern, Fatemehsadat Mireshghallah, Zhijing Jin, Bernhard Schölkopf, Mrinmaya Sachan, Taylor Berg-Kirkpatrick. Findings of ACL 2023 — https://aclanthology.org/2023.findings-acl.719/ · arXiv:2305.18462. Quoted: their attack *"outperform[s] LiRAs with more realistic assumptions about the quality of accessible data by **up to 100%**"*, and the motivating critique is that reference-based attacks *"make the strong and arguably unrealistic assumption that an adversary has access to samples closely resembling the original training data."*
- **SoK: Reducing the Vulnerability of Fine-tuned Language Models to Membership Inference Attacks.** arXiv:2403.08481 — https://arxiv.org/html/2403.08481v1. Quoted: *"The most effective defense strategies for most evaluated models and datasets are **differential-privacy based methods**"* (DP-SGD and DP-LoRA). Key usable numbers: **LoRA alone reduced MIA AUC-ROC to a maximum of 58.2%** with only **1.5M trainable params (Roberta-base)** and **0.88M (Flan-t5-base)**; *"all models fine-tuned using LoRA resulted in high reduction in MIA vulnerability."* Also: **larger batch sizes / fewer epochs reduce vulnerability**, and *"increasing the number of training iterations causes an increase in the privacy budget."*
- **Membership Inference Attacks against Fine-tuned Large Language Models via Self-prompt Calibration (SPV-MIA).** NeurIPS 2024 — https://proceedings.neurips.cc/paper_files/paper/2024/file/f36ad694188bb4c4bbbd61e2038e069e-Paper-Conference.pdf. Quoted: *"SPV-MIA raises the AUC of MIAs from **0.7** to a significantly high level of **0.9**"*, i.e. *"about **23.6% improvement in AUC** across four representative LLMs and three datasets."* The paper explicitly argues the membership signal should be grounded in **memorization**, not overfitting — *"memorization is intrinsic for machine learning models to achieve optimality and can persist in LLMs without leading to overfitting."*
- **Order of Magnitude Speedups for LLM Membership Inference.** EMNLP 2024 — https://aclanthology.org/2024.emnlp-main.253.pdf. Quoted: *"Fine tuning can amplify these risks, as models trained on smaller, specialized datasets are more susceptible to memorizing and revealing specific data points, and **specialized datasets not found on the open internet can contain sensitive user information**."* ← **A personal WeChat log is exactly a "specialized dataset not found on the open internet."** Their method works *"with as little as **6% of their computation budget**"* relative to shadow-model SOTA.

---

## 6. Hallucinated memories / confabulation in persona and companion agents

### 6.1 Benchmarks and their hallucination sub-scores

**CharacterEval: A Chinese Benchmark for Role-Playing Conversational Agent Evaluation.** Quan Tu, Shilong Fan, Zihang Tian, Tianhao Shen, Shuo Shang, Xin Gao, Rui Yan. **ACL 2024** (long), pp. 11836–11850. https://aclanthology.org/2024.acl-long.638/ · arXiv:2401.01275 · DOI 10.18653/v1/2024.acl-long.638

- **Hallucination is an explicit, named sub-metric.** Quoted: *"This involves assessing knowledge exposure, accuracy, and **hallucination** for knowledge consistency, and evaluating behavior and utterance consistency for persona consistency."*
- Structure: **13 metrics across 4 dimensions** (conversational ability, character consistency, role-playing attractiveness, personality back-testing via MBTI).
- **Dataset size discrepancy you must pick one of:** the arXiv v1 HTML and the GitHub README both state **1,785 dialogues / 23,020 examples**; the **ACL Anthology abstract states 1,785 dialogues / 11,376 examples / 77 characters.** Quote whichever you cite, and cite the version you took it from.
- **A relevant negative result:** *"Chinese LLMs exhibit more promising capabilities than GPT-4 in Chinese role-playing conversation"* and *"GPT-4's effectiveness diminishes in Chinese role-playing conversations. Its primary training in English corpus limits the adaptability in complex role-playing scenarios and the deep understanding of Chinese culture."* Directly relevant to a Chinese/English code-mixed clone: **the frontier English-centric model is the weakest option for the Chinese half of the register.**
- Companion artifact: **CharacterRM**, a role-playing reward model trained on **12 annotators**' five-point scores, reported to correlate with human judgement better than GPT-4.

**RoleEval: A Bilingual Role Evaluation Benchmark for Large Language Models.** Tianhao Shen, Sun Li, Deyi Xiong. 2023. arXiv:2312.16132 — https://arxiv.org/abs/2312.16132

- Quoted: *"RoleEval comprises RoleEval-Global... and RoleEval-Chinese..., with **6,000 Chinese-English parallel multiple-choice questions** focusing on **300 influential people and fictional characters**"*, covering **5 categories** (celebrities, anime/comics, movies/TV, games, fiction). Each character has **20 questions (17 basic + 3 multi-hop)**.
- **Hallucination is operationalised as a question type, not just a score:** *"**Non-occurrence Scenario Question**... questions test for non-occurrences, e.g., 'Did not happen…'. This format examines whether the model generates **illusions or false assumptions**."*
- Stated purpose, quoted: *"Our benchmark is designed to enhance the model's understanding of role knowledge, which is crucial for improving **persona consistency and factual accuracy while reducing hallucination**."*
- Sample sizes: **RoleEval-Global 200 characters / 4,000 questions; RoleEval-Chinese 100 characters / 2,000 questions.**
- **Caveat for WeClone:** this is *third-person* role knowledge about public figures. It does **not** test first-person autobiographical memory of a private individual — which is the actual hallucination risk for a persona clone. There is, as far as I found, **no benchmark for private-individual autobiographical-memory hallucination**; that is a genuine gap, not an oversight in my search (see §9).

### 6.2 Dedicated hallucination benchmarks and mitigation

**TimeChara: Evaluating Point-in-Time Character Hallucination of Role-Playing Large Language Models.** Jaewoo Ahn et al. Findings of ACL 2024 — https://aclanthology.org/2024.findings-acl.197/

- Quoted: *"agents must avoid **character hallucination, where they display knowledge that contradicts their characters' identities and historical timelines**. We introduce TimeChara... Comprising **10,895 instances** generated through an automated pipeline, this benchmark reveals **significant hallucination issues in current state-of-the-art LLMs (e.g., GPT-4o)**."*
- Mitigation proposed: **Narrative-Experts** (decompose reasoning steps, use narrative experts). Quoted: *"Still, our findings with TimeChara highlight the ongoing challenges of point-in-time character hallucination, calling for further study."*

**Mitigating Hallucination in Fictional Character Role-Play.** Nafis Sadeq et al. Findings of EMNLP 2024 — https://aclanthology.org/2024.findings-emnlp.846.pdf

- Quoted: *"The influence of parametric world knowledge of large language models (LLMs) often causes role-playing characters to **act out of character and to hallucinate about things outside the scope of their knowledge**."*
- Dataset **SGR (Script Grounded Character Role-play)**: *"over **2,000 characters** and **72,000 interviews**, including **18,000 adversarial questions**."*
- **Exact mitigation numbers (relative improvements over the primary baseline, GPT-3.5):** factual precision **+18.0%** (adversarial), **+15.7%** (open-ended), **+18.4%** (dialogue completion), **+14.8%** (scene-grounded); temporal hallucination reduced **32.7%** (dialogue completion) and **44.5%** (scene-grounded); **+22.9%** for less-popular characters.
- **This is the citation that names the confabulation mode most relevant to a clone:** cross-universe hallucination — *"Anakin from 'Star Wars' is asked how his friendship with Spock from 'Star Trek' influenced his decisions... The baseline response suffers from **cross-universe hallucination and mistakenly acknowledges the friendship**."* The persona-clone analogue is the model cheerfully "remembering" a shared event that never happened.
- **Ablation that quantifies where facts come from** (useful for WeClone's RAG design): removing parametric knowledge (anonymised prompts) dropped fact score **0.72 → 0.56**; removing retrieved knowledge dropped it to **0.58**; removing the role profile had the *lowest* impact, **0.72 → 0.64**. Quoted: *"the largest share of facts may be attributed to parametric knowledge."* ← **i.e. the model's own priors, not the persona card, supply most of what the character says. That is a mechanistic account of "costume over a generic body."**
- Their human evaluation rated **speaker style imitation** on a 1–7 scale alongside factuality — a directly reusable evaluation axis.

### 6.3 Related, uncited-here: roleplay-safety interaction

**Role play with large language models.** Murray Shanahan, Kyle McDonell, Laria Reynolds. **Nature** 623(7987):493–498, 2023. DOI 10.1038/s41586-023-06647-8. *(Encountered in the reference list of the ICASSP 2026 persona-drift paper; I did not open it. Listed for completeness as the canonical framing of role-play as "simulacra" rather than identity.)*

---

## 7. Rebuttals and skepticism

### 7.1 The single best paper for the owner's exact use case

**Catch Me If You Can? Not Yet: LLMs Still Struggle to Imitate the Implicit Writing Styles of Everyday Authors.** Zhengxiang Wang, Nafis Irtiza Tripto, Solha Park, Zhenzhen Li, Jiawei Zhou. **Findings of EMNLP 2025**, pp. 10040–10055, Suzhou, China. https://aclanthology.org/2025.findings-emnlp.532/ · PDF: https://aclanthology.org/2025.findings-emnlp.532.pdf · arXiv:2509.14543 · DOI 10.18653/v1/2025.findings-emnlp.532

This is the most direct published answer to "can an LLM imitate one specific everyday person's style?" — and the answer is a qualified no.

- Abstract, quoted: *"Results show that while LLMs can approximate user styles in **structured formats like news and email**, they **struggle with nuanced, informal writing in blogs and forums**."*
- Scale: *"over **40,000 generations per model** across domains such as news, email, forums, and blogs, covering writing samples from **more than 400 real-world authors**."*
- Four-metric ensemble, quoted: *"**authorship attribution, authorship verification, style matching, and AI detection**."*
- **The sentence that names WeClone's symptom:** *"Generated outputs often **default to an average, generic tone and remain readily detectable as AI-written**."*
- **More demonstrations do not fix it:** *"increasing the number of demonstrations offers limited gains in stylistic alignment."* Only 0-shot vs 5-shot were compared for AV accuracy, with *"the 5-shot setting consistently outperforms the 0-shot condition"*, but the paper's conclusion is that *"prompt design choices, such as length alignment and content similarity, moderately affect stylistic fidelity, but do not close the personalization gap."*
- **Domain ordering matters and is directly applicable:** performance was *"particularly well on CCAT50 and Enron, which feature more structured and formal writing. In contrast, performance is generally lower on **Reddit and Blog**, where writing tends to be more **informal and stylistically diverse**."* ← **WeChat chat is in the Reddit/Blog bucket, i.e. the worst case.**
- **A counter-intuitive retrieval finding, directly relevant to BM25 exemplar choice:** *"Content-based exemplar selection (+Sim ctrl) **surprisingly reduces attribution performance**, especially in Enron, Reddit, and Blog. While topical alignment improves, restricting exemplars to a narrow cluster appears to **diminish stylistic diversity**, making it harder for models to capture author-specific cues."* And *"Length alignment (+Len ctrl) yields modest gains in attribution... but it **lowers style-model accuracy**."*
  - **This is a direct, published challenge to the current design.** BM25 retrieval at chat time selects for **topical** similarity — exactly the "+Sim ctrl" condition this paper finds *degrades* style imitation.

### 7.2 Style-prompted text stays stylometrically attributable

**Be Sure to Use the Same Writing Style: Applying Authorship Verification on Large-Language-Model-Generated Texts.** Janith Weerasinghe, Ovendra Seepersaud, Genesis Smothers, Julia Jose, Rachel Greenstadt. **Applied Sciences** 15(5):2467, 2025. DOI 10.3390/app15052467 — https://doi.org/10.3390/app15052467

**This is the strongest single answer to "does style prompting break authorship attribution?" The answer is no — and it fails in an instructive direction.**

- Method, quoted: *"We generated texts by providing the language models with fanfiction snippets and prompting them to complete the rest of it **in the same writing style as the original snippet**. We then applied the AV model across the texts generated by the language models and the human written texts."* The AV model was *"trained only on human-written text."*
- **Result, quoted:** *"for GPT3 and ChatGPT, the **human–AI score is low**, indicating that the style of the AI-generated fanfiction is **very different from the original prompts, and that there is little style transfer from the prompts to the generated texts**."*
- **And the model-clustering result:** *"The GPT3 family LLMs have **high scores for both the AI–AI comparison and the AI–AI (different author) comparisons**. This indicates that the style is very similar across documents generated by the LLMs, **even when the prompts for the documents came from different authors**. This suggests that **GPT3 and ChatGPT have their own unique styles**."*
- Their hypothesis for *why*, quoted: *"**ChatGPT is optimized to be a conversational agent** that is tuned to generate coherent, user-friendly, dialogue-style responses, **which could have instilled a more uniform and distinct style**."* ← **This is the "thin costume" thesis, published, with a measured style-similarity score.**
- **Feature analysis found literal catchphrases:** *"One of the most prominent features in ChatGPT, GPT3, and LLaMA texts was the phrase **'t help but'** referring to phrases like 'can't help but wonder' and 'can't help but think'."* Also *"phrases with the form '[past tense verb], his'."* ← **A concrete, measured example of the model's own idiom overriding the requested author's.**
- Counter-intuitive version effect: *"texts generated with **GPT2** had the highest similarity to the human texts"* — i.e. **older/smaller models stayed closer to the prompt's style.** Their hypothesis: *"the larger models have a more defined style influenced by their more advanced architecture and would **stay closer to its own unique style rather than the source texts style**."* ← **Scaling up the model makes the costume thinner, not thicker.**

**Detecting Stylistic Fingerprints of Large Language Models.** Yehonatan Bitton, Elad Bitton, Shai Nisan. arXiv:2503.01659 — https://arxiv.org/abs/2503.01659

- Quoted: *"LLMs have **distinct and consistent stylistic fingerprints, even when prompted to write in different writing styles**."* And: *"These fingerprints are **consistent across domains, and persist even when the models are prompted to write in different writing styles**."*
- **Exact metrics:** unanimous 3-classifier ensemble, **precision 0.9988**, **false-positive rate 0.0004**. Unseen-model "no-agreement" rates: **phi-4 99.3%**, **Grok-1 100%**, **Mixtral 65%**. Striking cross-model result: **DeepSeek-R1 texts classified as OpenAI 74.2% of the time.**
- **This is the most decisive evidence that "write in my style" instructions do not overwrite the model's own signature.**

**Synergizing Stylometrics with Semantics: Dual-Path Framework for LLM Detection and Attribution (SSLA).** Xingyu Lu, Yumeng Ma, Xiang Zhou, Shengli Gan, Guiying Deng, Yang Wen, et al. Findings of ACL 2026. DOI 10.18653/v1/2026.findings-acl.1855 — https://aclanthology.org/2026.findings-acl.1855.pdf

- Names the property as a hypothesis, quoted as the **"Stylistic Stability Hypothesis"**: *"LLMs possess distinct and consistent stylistic fingerprints that **persist even when they are prompted to write in different writing styles**."*
- **Exact number:** *"SSLA achieves a **Macro-F1 score of 95.6%** on the challenging Wikipedia dataset."*
- **The framing is directly quotable for the owner's complaint:** *"When distinguishing an original author (e.g., Ernest Hemingway) from a skilled mimic — whether a human fan or an LLM — relying solely on surface content is often insufficient."* And: *"our research reveals that LLMs exhibit inherent **style inertia**."*
- **A measurable diagnostic they introduce, potentially reusable:** **"Stylistic Rigidity."** Quoted: *"If x is human-written, the standardized rewriting process induces **a significant drift (low similarity scores)**; if x is generated by an aligned LLM, **the style remains rigid (high similarity)**."*

**StyleDecipher: Robust and Explainable Detection of LLM-Generated Texts with Stylistic Analysis.** arXiv:2510.12608 — https://arxiv.org/html/2510.12608

- Quoted: *"in cross-domain evaluations, it surpasses existing baselines by **up to 36.30%**"*, across **five domains** (news, code, essays, reviews, academic abstracts). Their core signal: *"style divergence as the primary feature for detecting machine-generated text, based on the idea that LLM-generated text exhibits distinct stylistic patterns compared to human-written text."*

### 7.3 Detectors exist, are strong, and are also fragile — cite both

**DetectGPT: Zero-Shot Machine-Generated Text Detection using Probability Curvature.** Eric Mitchell, Yoonho Lee, Alexander Khazatsky, Christopher D. Manning, Chelsea Finn. **ICML 2023**, PMLR 202:24950–24962. https://proceedings.mlr.press/v202/mitchell23a.html · arXiv:2301.11305

- Abstract, quoted: *"text sampled from an LLM tends to occupy **negative curvature regions of the model's log probability function**."*
- **Exact headline number:** *"improving detection of fake news articles generated by 20B parameter GPT-NeoX from **0.81 AUROC** for the strongest zero-shot baseline to **0.95 AUROC** for DetectGPT."*
- Method needs only log-probabilities + T5 perturbations; no separate classifier, no dataset, no watermark.

**A Watermark for Large Language Models.** John Kirchenbauer, Jonas Geiping, Yuxin Wen, Jonathan Katz, Ian Miers, Tom Goldstein. **ICML 2023**, PMLR 202:17061–17084. https://proceedings.mlr.press/v202/kirchenbauer23a.html · arXiv:2301.10226

- Quoted: *"makes synthetic text detectable from short spans of tokens (**as few as 25 tokens**), while false-positives (where human text is marked as machine-generated) are **statistically improbable**."* Uses "green token" lists + a statistical test with interpretable p-values.

**The counterweight — a detector can be fooled, and style transfer is the attack.** **Stumbling Blocks: Stress Testing the Robustness of Machine-Generated Text Detectors Under Attacks.** ACL 2024 — https://aclanthology.org/2024.acl-long.160.pdf

- Quoted: *"almost none of the existing detectors remain robust under all the attacks, and all detectors exhibit different loopholes. **Averaging all detectors, the performance drops by 35% across all attacks.**"*
- *"**about 2 to 6-character editing by typo insertion can severely deceive metric-based detectors, such as DetectGPT, to perform worse than a random prediction**."*
- But note the honest ranking: *"**watermarking performs best for robust MGT detection**... Next, model-based detectors are more robust than metric-based ones in most cases."*

**MASH: Evading Black-Box AI-Generated Text Detectors via Style Humanization.** Findings of ACL 2026 — https://aclanthology.org/2026.findings-acl.1487.pdf

- Quoted: *"MASH achieves an average **Attack Success Rate (ASR) of 92%**, surpassing the strongest baselines by an average of **24%**"*, over **6 datasets and 5 detectors**, against **11 baseline evaders**. At a stringent **1% FPR** threshold, quoted: *"MASH suppresses the TPR to near zero levels."*
- **Critical design caveat, quoted:** *"The effectiveness of our Style-SFT module relies on the availability of a **seed set of human-written texts** that theoretically fall within the target detector's 'human' decision boundary."* And: *"If a detector fails to correctly classify ground-truth human text (i.e., exhibits high FPR), the adversarial objective of 'mimicking human style' becomes redundant."*
- **Honest summary of §7:** style prompt-tuning alone does **not** defeat stylometry (Weerasinghe et al., SSLA, Bitton et al.); but a *dedicated, adversarially-trained* style-humanisation pipeline **can** (MASH, 92% ASR). Prompting ≠ fine-tuning-with-DPO. WeClone's current approach is on the "does not work" side of that line.

### 7.4 Fine-grained imitation is possible — but stays statistically distinguishable

**Unsupervised / training-free authorship verification and style imitation analysis.** arXiv:2509.24930 — https://arxiv.org/pdf/2509.24930 *(author list not visible on the retrieved PDF page; cited by arXiv ID.)*

- Headline numbers: verifier accuracy **97.5%** on academic essays, **94.5%** cross-domain, with *"reducing training time by **91.8%** and memory usage by **59%**."*
- Prompting-strategy effect: *"few-shot prompting yields up to **23.5× higher style-matching accuracy** than zero-shot, and completion prompting reaches **99.9% agreement** with the original author's style."*
- **Zero-shot is essentially useless:** *"all models failed in the zero-shot condition (**accuracy below 7%**)"*, with verifier confidence **>95%** on those wrong predictions.
- **THE key sentence for the owner's complaint, quoted:** *"**Crucially, high-fidelity imitation does not imply human-like unpredictability: human essays average a perplexity of 29.5, whereas matched LLM outputs average only 15.2.**"* And: *"**stylistic fidelity and statistical detectability are separable**."* Threshold analysis: *"At thresholds ≤ 20, about **90% of generated texts** fell below, versus only **15% of human essays**."*
- Also: **one-shot is unstable** — *"intra-prompting-strategy accuracies varied wildly (**67.6% to 94.7%**)"*, with *"no clear correlation to model generation architecture or alignment strategy."*
- **This is the cleanest published statement of the owner's problem:** you can match the style *and* still be obviously a machine, because machine text is *too predictable*. Perplexity is a measurable proxy WeClone could adopt.

**Replicating a real author's style at the literary level fails on exactly the deep features.** **Analysis of persona assigned LLMs.** Ioana-Călina Pascu, Ștefan Trăușan-Matu. DOI 10.37789/icusi.2025.15 — https://doi.org/10.37789/icusi.2025.15

- Method: stylometric + idiolectal + rhythmic-prosodic features; models tried to reproduce **James Joyce** and **E.M. Forster**; measured with Euclidean distance, cosine similarity, Jensen-Shannon divergence, Jaccard index.
- **The layered result, quoted verbatim:** *"The pattern across measures is consistent: **lower-level cues (e.g., character n-grams, function-word ratios, basic POS distributions) align closely between original and generated texts, while higher-level structure (e.g., sentence-type proportions, dependency depth, rhetorical devices) diverges.** Generated passages tend toward shorter sentences, shallower dependency trees, and a flatter rhythmic profile."*
- And: *"the generated text contained **no neologisms**, failing to replicate Joyce's signature style of linguistic innovation... the LLM could detect and reproduce some devices (e.g., anaphora, epiphora, and onomatopoeia), but **their distribution and contextual embedding were less convincing**. Stress patterns were shorter and more uniform; syntactic parallelism was frequent but **overly regularized, suggesting reliance on internal templates rather than adaptive creativity**."*
- They mark this honestly: *"These statements are descriptive; statistical significance is not claimed here."*
- **Directly relevant to code-mixed WeChat text:** neologisms, invented spellings, and creative morphological constructions are exactly the "idiolectal" layer this study found **absent**. A code-mixed informal register is dominated by precisely the features the model drops.

**Forensic text comparison on per-author imitation.** **ChatGPT's ability to imitate writing styles: an analysis guided by forensic text comparison.** Shunichi Ishihara. *Digital Scholarship in the Humanities*, DOI 10.1093/llc/fqag079, published 15 May 2026 — https://doi.org/10.1093/llc/fqag079

- Method: **one-shot** training on short product-review texts from **300 authors**; likelihood-ratio-based forensic comparison on same-author / different-author pairs (human, machine, and mixed).
- Quoted: *"The findings indicate that **replicating writing styles remains a significant challenge for ChatGPT**."*
- **And the measured direction of the failure:** *"Linguistic analysis revealed that while both humans and machines exhibited preferred words and expressions, **these preferences were more strongly associated with the machine**."* ← **The model's catchphrases dominate the author's. This is the "costume" thesis with a likelihood-ratio measurement.**
- Related cited work (not opened): Zaitsu, Jin, Ishihara, Tsuge, Inaba, *"Can we spot fake public comments generated by ChatGPT(-3.5, -4)?: Japanese stylometric analysis expose emulation created by one-shot learning"*, PLoS ONE 19(3):e0299031, 2024, DOI 10.1371/journal.pone.0299031.

**Three-feature caution.** A widely-shared third-party stylometric study (TextPulse, *"Stylometric Fingerprints of AI Rewriting"*, PDF at https://textpulse.ai/research/textpulse-style-fingerprints-2026.pdf, **not peer-reviewed — treat as a blog-grade preprint**) claims across **60,786 paired human/AI rewrites**, **49 features**, **8 models / 6 families**: model identification at **64.3%** (multinomial logistic regression) vs **66.4%** (gradient boosting) against a **16.7%** chance rate; Cohen's d **1.57** for ≥7-letter words, **1.12** for nominalisations, **1.31** for lexical diversity. It also reports two **negative** findings worth flagging as a corrective to folklore: *"The word 'delve' is barely injected during rewriting, the word 'crucial' is not injected at all"*, and *"human writers repeat their sentence openers **2.7 times more often** than the models that supposedly write repetitively"* — i.e. **"AI writing is repetitive" is backwards at the sentence-opener level.** **UNVERIFIED / non-peer-reviewed.**

---

## 8. Overfitting to surface catchphrases

### 8.1 The direct, published statement of the WeClone failure mode

**Improving RAG for Personalization with Author Features and Contrastive Examples.** arXiv:2504.08745 — https://arxiv.org/html/2504.08745

**This is the single most actionable citation in this report for WeClone, because it describes the failure of exactly the architecture WeClone uses (RAG over a person's own historical documents).**

- Quoted verbatim: *"The key challenge with RAG is to capture fine-grained author features: retrieving separate, standalone samples from the author's history is not enough to recognize global patterns. **When presented with previous documents of the author, LLMs tend to memorize certain words and n-grams that are frequently used, instead of understanding the author's style.**"*
- Their fix (worth prototyping): inject **author features** — average sentiment polarity, most-frequent words, named entities, dependency patterns — plus **Contrastive Examples (CE)**, i.e. retrieve documents *from other authors* to make the target style's distinctiveness explicit. Choosing authors *"the least similar to the current author"*, using Contriever distances.
- **Exact gains:** *"A combination of CE and a couple of author features improve the RAG performance by **up to 15%**"* — described elsewhere as *"a relative **15% improvement over baseline RAG**."* A single sentence naming the author's most-used words, plus CE, produced the gain.
- **Exemplar counts:** **1 CE sample per author for LaMP-5; 3 samples for LaMP-4 and LaMP-7.** More is not better — *"Retrieving samples from 5 different authors performs worse than 3, possibly due to increased noise"*, and *"In LaMP-5, using too many contrastive examples even hurts the performance."*
- **Feature-type finding relevant to a Chinese/English code-mixed corpus:** *"features presented as **numerical values** (SP, SUBJ, ADVU, ADJU, PU) are less effective or even hurtful compared to ones presented as **words** (CE, WF, NEF, DPF)."* Reason given: *"LLMs' shortcoming of working with numerical values"* — in qualitative analysis, models *"overly polarizing (e.g. too negative or too positive) their outputs in the presence of numerical features"*, and *"They especially have a hard time adjusting to subjectivity and sentiment polarity, not being able to capture the nuances of scores that are closer to the mean."*
- Per-dataset nuance: **DPF (dependency patterns) helped most on tweets** — *"LaMP-7 is about tweets, which are highly personal and informal, dependency patterns better highlight individual's styles compared to others."* ← **Tweets are the closest public analogue to WeChat chat; syntax-shaped features beat word-frequency features there.**

### 8.2 Syntax-level templating: a measured, un-fixable-by-alignment form of repetition

**Syntactic templates paper** (title/author list not visible on the retrieved arXiv PDF page; identified as arXiv:2407.00211 — https://arxiv.org/pdf/2407.00211)

- Quoted: *"models tend to produce **templated text in downstream tasks at a higher rate than what is found in human-reference texts**. We find that most (**76%**) templates in model-generated text can be found in pre-training data (compared to only **35%** of human-authored text), and are **not overwritten during fine-tuning or alignment processes such as RLHF**."*
- **Exact numbers:**
  - OLMo: **75%** of templates found in pre-training data vs **34%** of randomly sampled non-templated sequences. Median rank in pre-training data: **337.5** for templates vs **9651.0** for non-templates (Mann-Whitney U=6043, p<0.05 two-tailed).
  - Rotten Tomatoes: **95% of model outputs contain templates of length n=6**, vs **38%** of human-written reference/input documents.
  - Memorization: *"the POS memorization definition finds **6.4% (±0.7)** memorized, whereas exact text match only reports **5.3% (±0.6)**"* — i.e. verbatim matching **undercounts** memorization by ~1.1 points because it misses *"synonym swaps, or different numbers being generated."*
- **Why this matters especially for a BM25-based clone:** the failure is at the **POS/syntactic** level, invisible to n-gram and TF-IDF metrics. A BM25 retriever and a distinct-n diversity check *both* sit above this layer and would report "fine" while the output is templated.

### 8.3 Catchphrases as a *design intent* in the WeChat-clone space — and its risk

Two real open-source projects in exactly this niche, both of which treat catchphrases as the primary style signal. Neither is peer-reviewed; cited as evidence of *what the community builds*, not as evidence of what works.

- **Chat-Style-Bot** — https://github.com/Chain-Mao/Chat-Style-Bot. Quoted (Chinese, from the README): *"Chat-Style-Bot是一个聊天风格模仿大语言模型，通过分析和学习微信聊天记录，可模仿你的说话风格（**口头禅**等），并可接入微信和你的朋友们自动聊天。"* ("…can imitate your speaking style (**catchphrases/mantras**, etc.)"). Uses LoRA SFT on GLM-4-9B-Chat / LLaMA-3-8B / Llama3-8B-Chinese-Chat / Qwen-2 (7B), **16–20 GB VRAM for LoRA** and **60 GB+ for full fine-tuning**, and adds **LlamaIndex RAG** to *"further improve style imitation ability and accuracy on detailed questions"* (`scripts/rag.py`). It inserts *"identity tags"* (bot name, author name) to help the model disambiguate speaker identity.
- **WeChatPersona** — https://github.com/zyayoung/WeChatPersona. Fine-tunes **Baichuan2-7B-Chat** on WeChat history to *"replicate the conversational style of your real friends on WeChat"*; input is a **WeChatMsg** CSV export, optionally using `StoreEmotion.db` for emotion descriptions.
- **Relevance:** the ecosystem's own framing is "imitate your 口头禅" — i.e. **the community optimises for exactly the surface-catchphrase proxy that §8.1 and §8.2 identify as the failure**, not for the underlying distribution. WeClone is not alone in this; that is the point.

### 8.4 The "costume" measured directly, in the closest published system

Cross-referencing §3.5 (IMPersona) and §7.2 (Weerasinghe et al.) gives the tightest available statement of the owner's complaint:

- IMPersona, on prompting-based impersonation: *"They tend to generate **overly polished, professional responses, incorporating only marginal stylistic elements from the examples**."*
- IMPersona, on the residual tell: *"a common failure across all prompting-based models was their **excessive enthusiasm**, which made them **easily identifiable as AI**."*
- Weerasinghe et al., on where the style actually came from: AI–AI similarity was *higher* than human–AI similarity, **even across different prompt authors**, leading them to conclude the models *"have their own unique styles."*

---

## 9. What I could NOT find — explicit negatives

Stated plainly, per the rules of this task:

1. **A paper titled "Measuring and Controlling Persona Drift in Language Model Dialogue" does not exist.** The real paper is arXiv:2402.10962. Its **v1** title was *"Measuring and Controlling Persona Drift in Language Model Dialogs"*; its **final title** (COLM 2024, v4) is *"Measuring and Controlling Instruction (In)Stability in Language Model Dialogs."* Cite the final title. Verified on https://arxiv.org/abs/2402.10962.
2. **"The Assistant Axis" exists** — arXiv:2601.10387, Lu, Gallagher, Michala, Fish, Lindsey, 15 Jan 2026. Verified on arXiv. (The request implied uncertainty; it is real.)
3. **No paper found that specifically measures "catchphrase overfitting" as a named phenomenon.** The behaviour is documented in three places with different vocabulary — *"memorize certain words and n-grams that are frequently used, instead of understanding the author's style"* (arXiv:2504.08745), the `t help but` feature analysis (DOI 10.3390/app15052467), and *"preferences were more strongly associated with the machine"* (DOI 10.1093/llc/fqag079) — but there is no canonical paper or metric by that name. **Do not attribute the term to any paper.**
4. **No benchmark exists for private-individual autobiographical-memory hallucination.** CharacterEval, RoleEval, TimeChara and SGR all target *public figures or fictional characters*. The specific risk of a clone "remembering" a shared event that never happened with a *private* person is, as far as this survey found, unmeasured. WeClone would need to build that evaluation itself.
5. **No paper found that measures persona-clone quality on Chinese/English code-mixed informal messaging specifically.** The closest are CharacterEval (Chinese, but fictional characters and novel/script register, not private chat) and IMPersona (real private messages, but English). **The intersection — code-mixed, informal, private, one specific real person — appears to be unstudied.**
6. **Unverified items**, listed so they are not accidentally cited as fact: the *Alignment Tax* paper (`alphaxiv.org/abs/2603.24124`); *"Where does output diversity collapse in post-training?"* (malformed alphaXiv URL); the TextPulse stylometric report (non-peer-reviewed); the ICASSP 2026 persona-drift `TtFD` definition (DOI landing page + reference list only, full text not opened). I could not confirm these on a publisher's own page.
7. **Author lists I am not asserting**, because the retrieved source did not show them: arXiv:2608.11426 (*Is Convergence Inevitable?*), arXiv:2608.07852 (*"Many Are My Names"*), MDPI *Electronics* 15(2):377, arXiv:2407.00211 (syntactic templates), arXiv:2509.24930. Titles, IDs and quoted numbers are from the sources; author attribution is left blank rather than guessed.
8. **One internal inconsistency to be aware of when citing:** CharacterEval's example count is **23,020** on arXiv/GitHub and **11,376** in the ACL Anthology abstract. Quote with the version you used.

---

## 10. Implications for WeClone (derived, not quoted)

Cross-referencing the evidence to the current architecture — BM25 retrieval of past messages at chat time, ~104k messages, code-mixed informal Chinese/English, complaint of "generic-assistant prose wearing a thin costume":

| # | Failure mode | Evidence | Why it applies to *this* design | Direction the literature points |
|---|---|---|---|---|
| 1 | Decoding-induced blandness | Holtzman 2019 (§1.1) | Independent of persona; a low-temperature/greedy path alone produces "*bland*" and "*overly generic language usage*" | Check the decode path first — cheapest possible fix |
| 2 | Assistant register is the model's relaxation state | Assistant Axis (arXiv:2601.10387); SAE personas (arXiv:2608.07852); assistant bias (arXiv:2609.00608) | A chat UI *is* an assistant conversation; post-training "*only loosely tethers*" the model. Personas "*retain the Assistant-associated feature core*" | Needs activation-level or architectural anchoring, not a better system prompt |
| 3 | Assistant-style prompting *itself* induces convergence | arXiv:2608.11426 (§1.4) | The persona prompt plus few-shot exemplars is the documented trigger condition; base models under *basic completion* were more diverse | Consider less assistant-shaped framing; test a completion-style path |
| 4 | Near-zero-shot style prompting does not transfer style | arXiv:2509.24930 (**<7%** zero-shot); arXiv:2509.14543 | Prompted imitation of an *everyday, informal* author is the worst-performing configuration in the literature | Full fine-tuning or LoRA, not prompting |
| 5 | Fine-tuning pushes toward *polite and structured* | MDPI *Electronics* 15(2):377 (§5.3) | SFT actively reorients output toward the alignment register, in late layers | The register problem may *get worse* after naive SFT |
| 6 | Persona fidelity decays in ~8 rounds / over 100+ rounds | arXiv:2402.10962 (**8 rounds**); EACL 2026 (100+ rounds) | Chit-chat is the *favourable* case, but task-shaped turns accelerate decay | Re-anchor the persona per turn; budget for drift |
| 7 | BM25/topical exemplar retrieval *hurts* style imitation | arXiv:2504.08745; arXiv:2509.14543 ("+Sim ctrl **surprisingly reduces** attribution performance") | BM25 selects for topic — the exact condition shown to *reduce* stylistic fidelity | Add contrastive examples from other authors; add syntax/POS features; consider length diversity over topicality |
| 8 | Syntactic templating is invisible to surface metrics | arXiv:2407.00211 (**n=6 templates in 95% of outputs vs 38% human**; **76%** of templates from pre-training) | BM25 and distinct-n both operate above the POS layer and will report "fine" | Evaluate at POS/syntax level |
| 9 | Verbatim replay risk from duplicated, long-context retrieval | arXiv:2202.07646 (**33%→65%** as context grows 50→450 tokens; duplication log-linear; dedup "**will not perfectly prevent leakage**"); arXiv:1802.08232 (private messages; **regularisation insufficient**) | A WeChat log is heavily self-duplicated and retrieval supplies long context | Similarity-threshold suppression at output time; canary audits; **note the tension with #2** |
| 10 | Suppressing the assistant register may *increase* verbatim leakage | arXiv:2311.17035 (**150×** via divergence from "*chatbot-style generations*"; alignment trains "*a unified chat-like persona*") | The fix for the owner's complaint is the documented precondition for the privacy failure | These two goals must be balanced explicitly, not sequentially |
| 11 | Success on style metrics ≠ human-like | arXiv:2509.24930 (**perplexity 29.5 human vs 15.2 LLM**; "*fidelity and detectability are separable*"); arXiv:2503.01659 (**precision 0.9988**) | A style score can improve while the text stays obviously machine-written | Add a perplexity/predictability metric as a separate axis |

---

## Sources

Every item below was retrieved and read in this session. "Opened" = I fetched the full landing/abstract page. "In results" = full abstract and quoted passages surfaced in retrieved search results from the publisher's own domain.

### Primary sources opened directly
1. Li, K., Liu, T., Bashkansky, N., Bau, D., Viégas, F., Pfister, H., Wattenberg, M. (2024). *Measuring and Controlling Instruction (In)Stability in Language Model Dialogs.* COLM 2024. **Opened** — https://arxiv.org/abs/2402.10962 *(v1 title: "Measuring and Controlling Persona Drift in Language Model Dialogs" — https://arxiv.org/html/2402.10962v1)*
2. Lu, C., Gallagher, J., Michala, J., Fish, K., Lindsey, J. (2026). *The Assistant Axis: Situating and Stabilizing the Default Persona of Language Models.* **Opened** — https://arxiv.org/abs/2601.10387
3. Xiao, Y., Zhang, V. J., Yang, C., Ma, N., Xuan, W., Huang, J. (2026). *The Chameleon's Limit: Investigating Persona Collapse and Homogenization in Large Language Models.* **Opened** — https://arxiv.org/abs/2604.24698
4. Wang, Z., Tripto, N. I., Park, S., Li, Z., Zhou, J. (2025). *Catch Me If You Can? Not Yet: LLMs Still Struggle to Imitate the Implicit Writing Styles of Everyday Authors.* Findings of EMNLP 2025, 10040–10055. **Opened** — https://aclanthology.org/2025.findings-emnlp.532/ · https://aclanthology.org/2025.findings-emnlp.532.pdf · arXiv:2509.14543
5. Jiang, L., Chai, Y., Li, M., Liu, M., Fok, R., Dziri, N., Tsvetkov, Y., Sap, M., Albalak, A., Choi, Y. (2025). *Artificial Hivemind: The Open-Ended Homogeneity of Language Models (and Beyond).* NeurIPS 2025 D&B (Oral). **Opened** — https://arxiv.org/abs/2510.22954 · https://papers.neurips.cc/paper_files/paper/2025/file/754d5a526a5ee5a47220664a0eb92751-Paper-Datasets_and_Benchmarks_Track.pdf
6. Shi, Q., Jimenez, C. E., Dong, S., Seo, B., Yao, C., Kelch, A., Narasimhan, K. (2025). *IMPersona: Evaluating Individual Level LM Impersonation.* **Opened** — https://arxiv.org/abs/2504.04332
7. Ahn, J., et al. (2024). *TimeChara: Evaluating Point-in-Time Character Hallucination of Role-Playing Large Language Models.* Findings of ACL 2024. https://aclanthology.org/2024.findings-acl.197/
8. Mattern, J., Mireshghallah, F., Jin, Z., Schölkopf, B., Sachan, M., Berg-Kirkpatrick, T. (2023). *Membership Inference Attacks against Language Models via Neighbourhood Comparison.* Findings of ACL 2023. https://aclanthology.org/2023.findings-acl.719/
9. Tu, Q., Fan, S., Tian, Z., Shen, T., Shang, S., Gao, X., Yan, R. (2024). *CharacterEval: A Chinese Benchmark for Role-Playing Conversational Agent Evaluation.* ACL 2024, 11836–11850. https://aclanthology.org/2024.acl-long.638/ · arXiv:2401.01275 · DOI 10.18653/v1/2024.acl-long.638
10. Shen, T., Li, S., Xiong, D. (2023). *RoleEval: A Bilingual Role Evaluation Benchmark for Large Language Models.* arXiv:2312.16132 · DOI 10.48550/arXiv.2312.16132
11. Mitchell, E., Lee, Y., Khazatsky, A., Manning, C. D., Finn, C. (2023). *DetectGPT: Zero-Shot Machine-Generated Text Detection using Probability Curvature.* ICML 2023, PMLR 202:24950–24962. https://proceedings.mlr.press/v202/mitchell23a.html · arXiv:2301.11305
12. Kirchenbauer, J., Geiping, J., Wen, Y., Katz, J., Miers, I., Goldstein, T. (2023). *A Watermark for Large Language Models.* ICML 2023, PMLR 202:17061–17084. https://proceedings.mlr.press/v202/kirchenbauer23a.html · arXiv:2301.10226
13. Carlini, N., Tramèr, F., Wallace, E., Jagielski, M., Herbert-Voss, A., Lee, K., Roberts, A., Brown, T., Song, D., Erlingsson, Ú., Oprea, A., Raffel, C. (2021). *Extracting Training Data from Large Language Models.* USENIX Security 2021. https://www.usenix.org/system/files/sec21-carlini-extracting.pdf · arXiv:2012.07805
14. Carlini, N., Ippolito, D., Jagielski, M., Lee, K., Tramèr, F., Zhang, C. (2022). *Quantifying Memorization Across Neural Language Models.* arXiv:2202.07646 · DOI 10.48550/arxiv.2202.07646
15. Carlini, N., Liu, C., Erlingsson, Ú., Kos, J., Song, D. (2019). *The Secret Sharer: Evaluating and Testing Unintended Memorization in Neural Networks.* USENIX Security 2019. https://www.usenix.org/system/files/sec19-carlini.pdf · arXiv:1802.08232
16. Nasr, M., Carlini, N., Hayase, J., Jagielski, M., Cooper, A. F., Ippolito, D., Choquette-Choo, C. A., Wallace, E., Tramèr, F., Lee, K. (2023). *Scalable Extraction of Training Data from (Production) Language Models.* arXiv:2311.17035
17. Qi, X., Zeng, Y., Xie, T., Chen, P.-Y., Jia, R., Mittal, P., Henderson, P. (2023). *Fine-tuning Aligned Language Models Compromises Safety, Even When Users Do Not Intend To!* ICLR 2024. arXiv:2310.03693 · https://proceedings.iclr.cc/paper_files/paper/2024/file/83b7da3ed13f06c13ce82235c8eedf35-Paper-Conference.pdf
18. Gekhman, Z., Yona, G., Aharoni, R., Eyal, M., Feder, A., Reichart, R., Herzig, J. (2024). *Does Fine-Tuning LLMs on New Knowledge Encourage Hallucinations?* EMNLP 2024, 7765–7784. https://aclanthology.org/2024.emnlp-main.444/ · DOI 10.18653/v1/2024.emnlp-main.444
19. Sharma, M., Tong, M., Korbak, T., Duvenaud, D., Askell, A., Bowman, S. R., Cheng, N., Durmus, E., Hatfield-Dodds, Z., Johnston, S. R., Kravec, S., Maxwell, T., McCandlish, S., Ndousse, K., Rausch, O., Schiefer, N., Yan, D., Zhang, M., Perez, E. (2023). *Towards Understanding Sycophancy in Language Models.* ICLR 2024. arXiv:2310.13548 · https://arxiv.org/html/2310.13548 · https://www.anthropic.com/research/towards-understanding-sycophancy-in-language-models
20. Holtzman, A., Buys, J., Du, L., Forbes, M., Choi, Y. (2019). *The Curious Case of Neural Text Degeneration.* ICLR 2020. arXiv:1904.09751 · https://arxiv.org/pdf/1904.09751
21. Kirk, R., Mediratta, I., Nalmpantis, C., Luketina, J., Hambro, E., Grefenstette, E., Raileanu, R. (2023). *Understanding the Effects of RLHF on LLM Generalisation and Diversity.* ICLR 2024. arXiv:2310.06452 · https://proceedings.iclr.cc/paper_files/paper/2024/file/5a68d05006d5b05dd9463dd9c0219db0-Paper-Conference.pdf
22. Shumailov, I., Shumaylov, Z., Zhao, Y., Papernot, N., Anderson, R., Gal, Y. (2024). *AI models collapse when trained on recursively generated data.* Nature 631, 755–759. DOI 10.1038/s41586-024-07566-y · https://www.nature.com/articles/s41586-024-07566-y
23. Luz de Araujo, P. H., Hedderich, M. A., Modarressi, A., Schütze, H., Roth, B. (2026). *Persistent Personas? Role-Playing, Instruction Following, and Safety in Extended Interactions.* EACL 2026. https://aclanthology.org/2026.eacl-long.246/ · https://aclanthology.org/2026.eacl-long.246.pdf · arXiv:2512.12775
24. Lu, X., Ma, Y., Zhou, X., Gan, S., Deng, G., Wen, Y., et al. (2026). *Synergizing Stylometrics with Semantics: Dual-Path Framework for LLM Detection and Attribution (SSLA).* Findings of ACL 2026. DOI 10.18653/v1/2026.findings-acl.1855 · https://aclanthology.org/2026.findings-acl.1855.pdf
25. Weerasinghe, J., Seepersaud, O., Smothers, G., Jose, J., Greenstadt, R. (2025). *Be Sure to Use the Same Writing Style: Applying Authorship Verification on Large-Language-Model-Generated Texts.* Applied Sciences 15(5):2467. DOI 10.3390/app15052467
26. Bitton, Y., Bitton, E., Nisan, S. (2025). *Detecting Stylistic Fingerprints of Large Language Models.* arXiv:2503.01659
27. Krishna, K., Wieting, J., Iyyer, M. (2020). *Reformulating Unsupervised Style Transfer as Paraphrase Generation.* EMNLP 2020. https://aclanthology.org/2020.emnlp-main.55.pdf
28. Jafaritazehjani, S., Lecorvé, G., Lolive, D., Kelleher, J. (2020). *Style versus Content: A distinction without a (learnable) difference?* COLING 2020. https://aclanthology.org/2020.coling-main.197.pdf
29. Mir, R., Felbo, B., Obradovich, N., Rahwan, I. (2019). *Evaluating Style Transfer for Text.* arXiv:1904.02295
30. Pauli, A. B., Augenstein, I., Assent, I. (2025). *Mind the Style Gap: Meta-Evaluation of Style and Attribute Transfer Metrics.* Findings of EMNLP 2025. DOI 10.18653/v1/2025.findings-emnlp.1175
31. Sadeq, N., et al. (2024). *Mitigating Hallucination in Fictional Character Role-Play.* Findings of EMNLP 2024. https://aclanthology.org/2024.findings-emnlp.846.pdf
32. *Stumbling Blocks: Stress Testing the Robustness of Machine-Generated Text Detectors Under Attacks.* ACL 2024. https://aclanthology.org/2024.acl-long.160.pdf
33. *MASH: Evading Black-Box AI-Generated Text Detectors via Style Humanization.* Findings of ACL 2026. https://aclanthology.org/2026.findings-acl.1487.pdf
34. *Improving RAG for Personalization with Author Features and Contrastive Examples.* arXiv:2504.08745 · https://arxiv.org/html/2504.08745
35. *Is Convergence Inevitable? Tracing Output Homogeneity Back to Base Models.* arXiv:2608.11426 *(author list not retrieved)*
36. *"Many Are My Names": The Anatomy of the Assistant and Its Properties via Sparse Autoencoders.* arXiv:2608.07852 *(author list not retrieved)*
37. *Investigating Assistant Bias in LLM User Simulators Using a Role Vector.* arXiv:2609.00608
38. *Instruction Fine-Tuning Through the Lens of Verbatim Memorization.* Electronics 15(2):377, 2026. DOI 10.3390/electronics15020377 *(author list not retrieved)*
39. *Membership Inference Attacks against Fine-tuned Large Language Models via Self-prompt Calibration (SPV-MIA).* NeurIPS 2024. https://proceedings.neurips.cc/paper_files/paper/2024/file/f36ad694188bb4c4bbbd61e2038e069e-Paper-Conference.pdf
40. *SoK: Reducing the Vulnerability of Fine-tuned Language Models to Membership Inference Attacks.* arXiv:2403.08481 · https://arxiv.org/html/2403.08481v1
41. *Order of Magnitude Speedups for LLM Membership Inference.* EMNLP 2024. https://aclanthology.org/2024.emnlp-main.253.pdf
42. *Style-Specific Neurons for Steering LLMs in Text Style Transfer (sNeuron-TST).* arXiv:2410.00593 · https://arxiv.org/html/2410.00593v1
43. *StyleDecipher: Robust and Explainable Detection of LLM-Generated Texts with Stylistic Analysis.* arXiv:2510.12608 · https://arxiv.org/html/2510.12608
44. *Training-free authorship verification and style imitation analysis.* arXiv:2509.24930 *(author list not retrieved)*
45. *Syntactic templates* (title not retrieved in full). arXiv:2407.00211 *(author list not retrieved)*
46. Ishihara, S. (2026). *ChatGPT's ability to imitate writing styles: an analysis guided by forensic text comparison.* Digital Scholarship in the Humanities. DOI 10.1093/llc/fqag079
47. Pascu, I.-C., Trăușan-Matu, Ș. (2025). *Analysis of persona assigned LLMs.* DOI 10.37789/icusi.2025.15
48. *Persona Drift Detection in Role-Playing Agents: A Multi-Dimensional Consistency Framework.* ICASSP 2026. DOI 10.1109/icassp55912.2026.11463024 *(full text not opened; DOI landing page + reference list only)*
49. Hou, Z. J., Chen, Z., Zhang, M., Li, X. L. (2026). *Rethinking Post-training Diversity Collapse: Is Diversity-preserving Post-training Enough?* ICML 2026 GenAI Creativity workshop. https://genaicreativity.org/icml2026/files/54/54_paper.pdf

### Non-archival / community sources (cited as ecosystem evidence, not as findings)
50. Chain-Mao. *Chat-Style-Bot* (WeChat chat-style-imitation LLM; 口头禅). https://github.com/Chain-Mao/Chat-Style-Bot
51. zyayoung. *WeChatPersona* (Baichuan2-7B-Chat fine-tuned on WeChat history). https://github.com/zyayoung/WeChatPersona
52. CharacterEval repository. https://github.com/morecry/CharacterEval
53. RoleEval repository. https://github.com/magnetic2014/roleeval
54. persona_drift reference implementation (Li et al., COLM 2024). https://github.com/likenneth/persona_drift

### Retrieved but NOT verified on a publisher page — do not cite as fact
55. *The Alignment Tax: Response Homogenization in Aligned LLMs and Its Implications for Uncertainty Estimation.* alphaXiv only — https://www.alphaxiv.org/abs/2603.24124 — **UNVERIFIED**
56. *Where does output diversity collapse in post-training?* — alphaXiv, malformed/unresolvable URL — **UNVERIFIED**
57. *Stylometric Fingerprints of AI Rewriting: Punctuation, Syntax, and Model Attribution Across 60,786 Paired Texts.* https://textpulse.ai/research/textpulse-style-fingerprints-2026.pdf — **non-peer-reviewed, UNVERIFIED**
