# Stream: PAN / authorship-attribution evidence base for short texts and evaluation methodology

**Purpose.** Evidence base for a survey on building a faithful imitation ("persona clone") of one
real person from ~104k of their own WeChat messages (Chinese/English code-mixed, informal).
Two axes: (a) **short-text attribution** — how much text is actually needed; (b) **evaluation
methodology** — what the PAN shared tasks measured, with what corpora, what baselines, and what
score a "good" system gets.

**Reading-status convention used below (important).**
- `[OPENED]` — the full primary PDF/page was fetched and read in this session.
- `[SNIPPET]` — the record was retrieved as a search hit, but the primary file was not opened;
  only the quoting page/snippet was read. Treat the numbers as reported-by-secondary.
- `[UNVERIFIED]` — could not verify. Marked inline.

Every number below is copied from the cited source. Nothing is reconstructed from memory.

---

## 1. PAN shared tasks on authorship attribution / verification / identification

### 1.1 PAN 2011 — the first standardized testbed `[OPENED]`
**Argamon & Juola, "Overview of the International Authorship Identification Competition at PAN-2011", CLEF 2011 Working Notes, CEUR-WS Vol-1177.**
URL: https://ceur-ws.org/Vol-1177/CLEF2011wn-PAN-ArgamonEt2011.pdf (also https://downloads.webis.de/pan/publications/papers/argamon_2011.pdf)

- **Two tasks**: *authorship attribution* (which of a known set of authors wrote a text) and
  *authorship verification* (did a specific author write a text). 13 research groups submitted
  results across **7 tasks**; 8 submitted papers.
- **Corpus**: derived from the **Enron email corpus**. 5 training collections + 7 test collections.
  - Attribution training, "Large": **9,337 documents by 72 authors**.
  - Attribution training, "Small": **3,001 documents by 26 authors** (author sets disjoint).
  - Each attribution problem has two test sets: one containing only in-training-set authors,
    one also containing texts by ~**20 other authors** each.
  - Verification training sets: **three**, each single-author, containing **42, 55, and 47
    documents** respectively. Each has a test set mixing that author's documents with others'.
  - Redaction: names/emails replaced token-wise by `¡NAME/¿`, `¡EMAIL/¿`. Some texts are
    non-English or automatically generated.
- **Measures**: precision, recall, F1, both **macro-averaged and micro-averaged**; overall ranking
  by **rank sum** over six attribution measures / three verification measures (lower = better).
- **Results**:
  - Attribution: **Tanguy et al.** ranked best across all four attribution tasks (they used the
    largest and most diverse feature set).
  - Verification: **Tim Snider (Porfiau, Canada)** had the **best precision overall**, but not the
    highest recall.
  - Verification table (Fig. 6): best rank-sum is `tanguy-2011-06-07-1700` with macro
    P/R/F1 = **0.688 / 0.267 / 0.321**, micro P/R/F1 = **0.779 / 0.471 / 0.587**. Snider:
    macro **0.654 / 0.227 / 0.258**, micro **0.627 / 0.405 / 0.492**. Highest precision run:
    `tanguy-2011-06-07-1600` micro precision **0.924** at recall **0.299**.
- **Key qualitative finding (quoted)**: "authorship verification is considerably more difficult
  than authorship attribution. High precision evidently is easier to achieve than high recall."
  And: "one characteristic of all the better methods seems to be a preference for precision over
  recall".
- Participant-side confirmation of corpus shape: **Tanguy et al. notebook** (CEUR Vol-1177)
  states training sets of "3,000 messages from 26 authors (small) and 10,000 messages from 72
  authors (large)", test sets ranging **400–1,500 messages**, and for verification "for each
  author the training data contained about **50 messages**, and test data about **100**".
  URL: https://ceur-ws.org/Vol-1177/CLEF2011wn-PAN-TanguyEt2011.pdf
  Their own verification macro-scores were catastrophic: Verify1 **P 0.091 / R 0.333 / F 0.143**,
  Verify2 **0.100 / 0.200 / 0.133**, Verify3 **0.083 / 0.250 / 0.125**.

### 1.2 PAN 2012 — the traditional attribution subtask + author clustering `[SNIPPET]`
**Juola, "An Overview of the Traditional Authorship Attribution Subtask", CLEF 2012 Working Notes, CEUR-WS Vol-1178.**
URL: https://ceur-ws.org/Vol-1178/CLEF2012wn-PAN-Juola2012.pdf

- Deliberate **change of design** vs 2011: fewer but larger documents, different genre, markup
  removed, and a new sub-sub-task (**authorship clustering**, a.k.a. intrinsic plagiarism).
- Genre: free fiction from **Feedbooks.com**. **25 teams** participated.
- Corpus: **8 problems** — 3 closed-class attribution, 3 open-class, 2 clustering.
  - Problems A/B (shared training): **2 samples each by 3 authors** (6 training docs); samples
    **between 1,800 and 6,060 words**. Test A = **6** docs; Test B = **6 + 4 "none of the above"
    = 10** docs.
  - Problems C/D (shared training): **8 authors, 2 samples each = 16** training docs, up to
    **~13,000 words**. Test C = **8**; Test D = **8 + 9 out-of-class = 17**.
  - Problems I/J: **14 authors**, 28 training docs, novella/novel length **~40,000 to ~170,000
    words**; Test I = **14**, Test J = **16**.
  - Problem E = **90** docs (clustering), Problem F = **80** docs (single-intrusion clustering).
  - Problems G/H were discarded due to a **test-data leak** and replaced by I/J.
- Clustering setup: problems E1/E2/E3 contain intermixed paragraphs from 2 / 3 / 4 authors; all
  authorship changes occur at **paragraph boundaries**; no control for subject or authorial voice.

### 1.3 PAN 2013 — author verification, the reference edition `[OPENED]`
**Juola & Stamatatos, "Overview of the Author Identification Task at PAN 2013", CLEF 2013 Working Notes, CEUR-WS Vol-1179.**
URLs: https://ceur-ws.org/Vol-1179/CLEF2013wn-PAN-JuolaEt2013.pdf · https://downloads.webis.de/pan/publications/papers/juola_2013.pdf

- **Task definition**: given a set of documents by a single author (**no more than 10, possibly
  only one**) plus **exactly one questioned document**, decide whether the questioned document was
  written by that author. Framed explicitly after Koppel et al.'s "fundamental problem".
- **First year with software-only submissions**, run and evaluated in **TIRA** — making runtime
  comparable for the first time.
- **Languages**: English, Greek, Spanish.
- **Dataset sizes**:
  | split | English | Greek | Spanish | total |
  |---|---|---|---|---|
  | training problems | 10 | 20 | 5 | **35** |
  | evaluation problems | 30 | 30 | 25 | **85** |
  | early-bird subset | 20 | 20 | 15 | **55** |
  Positive/negative distribution **balanced** in every corpus and sub-corpus.
- **Genres / document sizes**:
  - English (collected by Patrick Brennan, Juola & Associates): extracts from published
    **computer-science/IT textbooks**, pool of **16 authors**, **~1,000 words per document**,
    formulas and code removed; paired documents range from very narrow genre (all Java textbooks)
    to divergent (Cyber Crime vs. Digital Systems Design).
  - Greek: **newspaper opinion articles** from the weekly *TO BHMA*, 1996–2012; pool of **>800
    articles by ~100 authors**; each article **≥1,000 words**; positives were deliberately chosen
    to be *stylistically dissimilar* and negatives *stylistically similar* (via character 3-gram
    + dissimilarity measure d1), making the Greek part the hardest.
  - Spanish: excerpts from newspaper **editorials and short fiction**.
  - Overall, the **majority of documents comprise 1,000–1,500 words**.
- **Measures**: recall, precision, F1 (ranking by F1 over the whole 3-language corpus). Plus
  **ROC-AUC** for the 10 of 18 participants who also submitted real scores in [0,1]. Random
  guessing baseline = **F1 0.500, AUC 0.500**.
- **Results — 18 teams**:
  | rank | submission | F1 | Precision | Recall | Runtime |
  |---|---|---|---|---|---|
  | 1 | **Seidman** (modified Impostors method) | **0.753** | 0.753 | 0.753 | 65,476,823 |
  | 2 | **Halvani, Steinebach & Zimmermann** | **0.718** | 0.718 | 0.718 | 8,362 |
  | 3= | Layton, Watters & Dazeley | 0.671 | 0.671 | 0.671 | 9,483 |
  | 3= | Petmanson | 0.671 | 0.671 | 0.671 | 36,214,445 |
  | 7 | Bobicev | 0.655 | 0.663 | 0.647 | 1,713,966 |
  | 16 | Kern | 0.529 | 0.529 | 0.529 | 624,366 |
  | — | **BASELINE** | **0.500** | 0.500 | 0.500 | — |
  | 18 | Sorin | 0.331 | 0.633 | 0.224 | 3,643,942 |
- **Best AUC**: **Jankowska, Kešelj & Milios — 0.777** overall (EN **0.842**, GR **0.711**,
  ES **0.804**). Then **Seidman 0.735** (EN 0.792, GR **0.824**, ES 0.583) and **Ghaeini 0.729**
  (EN 0.837, GR 0.527, ES **0.926**). Baseline AUC 0.500.
- Per-language best F1: EN **0.800** (Seidman and Veenman & Li, tied); GR **0.833** (Seidman);
  ES **0.840** (Halvani et al.).
- **Meta-model (majority vote over all 18 binaries)**: F1 **0.814**, Precision **0.829**,
  Recall **0.800**, AUC **0.841** — better than any individual except Seidman on Greek.
- Text-length/feature census from the 16 notebooks: most popular character features were letter
  frequencies, **punctuation-mark frequencies**, **character n-grams**, common prefixes/suffixes;
  most popular lexical features were word frequencies, word n-grams, **function words**,
  function-word n-grams.

### 1.4 PAN 2014 — c@1 introduced; the largest classical corpus `[OPENED]`
**Stamatatos, Daelemans, Verhoeven, Potthast, Stein, Juola, Sanchez-Perez & Barrón-Cedeño, "Overview of the Author Identification Task at PAN 2014".**
URL: https://downloads.webis.de/pan/publications/papers/stamatatos_2014.pdf

- **Task**: same as PAN 2013 (known docs by one author + exactly one questioned doc), but
  **max 5 known documents per problem** (down from 10), and documents within a problem are still
  matched for genre, register, theme and date.
- **Languages/genres**: Dutch (essays, reviews), English (essays, novels), Greek (articles),
  Spanish (articles) — **4 languages, 4 genres, 6 sub-corpora**.
- **Dataset sizes (Table 1)**:
  | split | corpus | #Problems | #Docs | avg known docs/prob | avg words/doc |
  |---|---|---|---|---|---|
  | Training | Dutch essays | 96 | 268 | 1.8 | 412.4 |
  | Training | Dutch reviews | 100 | 202 | 1.0 | 112.3 |
  | Training | English essays | 200 | 729 | 2.6 | 848.0 |
  | Training | English novels | 100 | 200 | 1.0 | 3,137.8 |
  | Training | Greek articles | 100 | 385 | 2.9 | 1,404.0 |
  | Training | Spanish articles | 100 | 600 | 5.0 | 1,135.6 |
  | **Training total** | | **696** | **2,384** | **2.4** | **1,091.0** |
  | Evaluation | Dutch essays | 96 | 287 | 2.0 | 398.1 |
  | Evaluation | Dutch reviews | 100 | 202 | 1.0 | 116.3 |
  | Evaluation | English essays | 200 | 718 | 2.6 | 833.2 |
  | Evaluation | English novels | 200 | 400 | 1.0 | 6,104.0 |
  | Evaluation | Greek articles | 100 | 368 | 2.7 | 1,536.6 |
  | Evaluation | Spanish articles | 100 | 600 | 5.0 | 1,121.4 |
  | **Evaluation total** | | **796** | **2,575** | **2.2** | **1,714.9** |
  | **GRAND TOTAL** | | **1,492** | **4,959** | **2.3** | **1,415.0** |
  (Reported figures use European decimal commas: 412,4 = 412.4 etc.)
- Corpus provenance worth noting: Dutch = adapted **CLiPS Stylometry Investigation (CSI)** corpus,
  student essays and reviews from University of Antwerp 2012–2014 (200 review problem sets + 192
  essay problem sets). English essays = **Uppsala Student English (USE)** corpus, **440 authors**,
  **1,489 documents**, avg essay **820 words**; a hard constraint required every document to
  contain **≥500 words**, which reduced the usable set to **435 authors**; case generation also
  matched students by term and age band. English novels = **"Cthulhu Mythos"** shared-universe
  speculative/horror fiction. Spanish = *El País* opinion articles, always **exactly 5 known
  texts**, avg length exceeding 1,000 words.
- **Measures**: **AUC** (ranking quality) and **c@1** (accuracy that rewards unanswered problems).
  Final score = **AUC × c@1**.
  `c@1 = (1/n)·(n_c + (n_u · n_c / n))`, where score > 0.5 → positive, < 0.5 → negative,
  **exactly 0.5 → unanswered**. If nothing is left unanswered, **c@1 = accuracy**. If everything is
  left unanswered, c@1 = 0. Random baseline: AUC 0.5, c@1 0.5, final 0.25.
- **Baseline**: not random — the **best PAN-2013 software (Jankowska et al.)**, reused as a
  language-independent standard method. Baseline final score **0.325**.
- **Results — 13 submissions** (from Australia, Canada ×2, France, Germany ×2, India, Iran,
  Ireland, Mexico ×2, UAE, UK). Ranked by final score AUC·c@1:
  | Final score | Team |
  |---|---|
  | **0.566** | **Meta-classifier** (average of all 13) |
  | **0.490** | **Khonji & Iraqi** (Khalifa University, UAE) — **best AUC**; ~21 hours runtime |
  | **0.484** | **Fréry, Largeron & Juganaru-Mathieu** (Université de Lyon / ENS Mines) — **best c@1** |
  | 0.461 | Castillo, Cervantes, Vilariño, Pinto & León (Mexico) |
  | 0.451 | Moreau, Jayapal & Vogel (TCD) |
  | 0.450 | Mayor et al. (UNAM) |
  | 0.426 | Zamani et al. (Tehran) |
  | 0.400 | Satyam et al. (BIT India) |
  | 0.375 | Modaresi & Gross |
  | 0.367 | Jankowska, Kešelj & Milios |
  | 0.335 | Halvani & Steinebach |
  | **0.325** | **Baseline** |
  | 0.308 | Vartapetiance & Gillam |
  | 0.306 | Layton |
  | 0.304 | Harvey |
- **Fréry et al.'s own notebook** `[OPENED]` (CEUR-WS Vol-1180,
  https://ceur-ws.org/Vol-1180/CLEF2014wn-Pan-FreryEt2014.pdf) gives the winning-c@1
  decomposition: **overall AUC 70.7%, c@1 68.4%, final 0.484**; per corpus AUC **EN essays 61%,
  EN novels 72%, Dutch reviews 60%, Dutch essays 90%, Spanish 77%, Greek 68%**; c@1 **59%, 71%,
  58%, 90%, 75%, 64%**; ranks **1/13 on English essays**, 2/13 Dutch essays, 4/13 Spanish.
- Key structural finding: **the meta-classifier beat every individual system** and "clearly
  outperforms the convex hull of all the submitted methods in the whole range of the curve."
  Also: the **Dutch reviews** corpus is the hardest (only one known document, short texts);
  Greek/Spanish (multiple long known documents) are easiest in average performance.
- Only **4 of 13** participants answered all problems; **the best five all left some unanswered.**

### 1.5 PAN 2015 — cross-topic and cross-genre verification `[OPENED]`
**Stamatatos, Daelemans, Verhoeven, Juola, López-López, Potthast & Stein, "Overview of the Author Identification Task at PAN 2015".**
URL: https://downloads.webis.de/publications/papers/stamatatos_2015b.pdf

- **The critical methodological change**: it is **no longer assumed that documents within a
  problem match in genre and/or topic** — cross-genre + cross-topic verification. Same setup as
  PAN 2014 otherwise; positive and negative answers equally likely; score in [0,1], 0.5 = abstain.
- **Dataset sizes (Table 1)**:
  | split | corpus | #Problems | #Documents | avg known docs | avg words/doc |
  |---|---|---|---|---|---|
  | Training | Dutch cross-genre | 100 | 276 | 1.76 | 354 |
  | Training | English cross-topic | 100 | 200 | 1.00 | 366 |
  | Training | Greek cross-topic | 100 | 393 | 2.93 | 678 |
  | Training | Spanish mixed | 100 | 500 | 4.00 | 954 |
  | Test | Dutch cross-genre | 165 | 452 | 1.74 | 360 |
  | Test | English cross-topic | **500** | 1,000 | 1.00 | 536 |
  | Test | Greek cross-topic | 100 | 380 | 2.80 | 756 |
  | Test | Spanish mixed | 100 | 500 | 4.00 | 946 |
  | **Σ** | | **1,265** | **3,701** | **1.93** | **641** |
- The **English part gives only one known document per problem**; the Spanish part always **four**.
  Dutch and English documents are **under 500 words** on average; Greek and Spanish exceed 500.
- **Baselines** (real systems from earlier PANs, applied via TIRA):
  PAN13-BASELINE (Jankowska et al.) micro 0.358 / macro 0.347;
  PAN14-BASELINE-1 (Fréry et al.) micro 0.269 / macro 0.280;
  PAN14-BASELINE-2 (Castillo et al.) micro 0.406 / macro 0.405.
  Random-guess final score = **0.25**.
- **Results — 18 teams** (final score = AUC · c@1):
  | Team | Dutch | English | Greek | Spanish | Micro-avg | Macro-avg |
  |---|---|---|---|---|---|---|
  | **Bagnall** | 0.451 | **0.614** | **0.750** | 0.721 | **0.608** | **0.628** |
  | Moreau et al. | **0.635** | 0.453 | 0.693 | 0.661 | 0.534 | 0.606 |
  | Hürlimann et al. | 0.616 | 0.412 | 0.599 | 0.539 | 0.487 | 0.538 |
  | Pacheco et al. | 0.624 | 0.438 | 0.517 | 0.663 | 0.480 | 0.558 |
  | Halvani | 0.455 | 0.458 | 0.493 | 0.441 | 0.445 | 0.462 |
  | PAN15-ENSEMBLE | 0.426 | 0.468 | 0.537 | 0.715 | 0.475 | 0.532 |
  | PAN14-BASELINE-1 | 0.255 | 0.249 | 0.198 | 0.443 | 0.269 | 0.280 |
  | PAN14-BASELINE-2 | 0.191 | 0.409 | 0.412 | 0.683 | 0.406 | 0.405 |
  | PAN13-BASELINE | 0.242 | 0.404 | 0.384 | 0.367 | 0.358 | 0.347 |
  | Nikolov et al. | 0.089 | 0.258 | 0.454 | 0.095 | 0.217 | 0.201 |
  | Mechti et al. | — | 0.247 | — | — | 0.207 | 0.063 |
  | Bartoli et al. | 0.518 | 0.323 | 0.458 | **0.773** | 0.417 | 0.506 |
- **Bagnall's per-language detail**: Dutch AUC 0.70 / c@1 0.64 / score 0.45 / rank 7;
  **English AUC 0.81 / c@1 0.76 / score 0.61 / rank 1**; **Greek AUC 0.88 / c@1 0.85 / score
  0.75 / rank 1**; Spanish AUC 0.89 / c@1 0.81 / score 0.72 / rank 2.
- **The ensemble failed for the first time.** "Unlike the evaluation results of PAN-2013 and
  PAN-2014, the ensemble of all participants is not the best-performing approach... outperformed
  by 5 and 4 participants" (micro and macro respectively). Reason given: the low average quality
  of submissions — **6 of 18 participants scored below 0.3 micro** (near the 0.25 random level),
  whereas **all** PAN-2014 participants exceeded 0.3.
- **THE most important quote for the short-text question** (verbatim, §7):
  > "Text-length is one important issue that has not been thoroughly studied within authorship
  > verification research. How long should the texts of known authorship be in order to allow for
  > training reliable verification models? How many words of the unknown documents are really
  > needed to allow for computing an accurate answer? Answers to such and similar questions are
  > critical in case we wish to apply this technology to short texts, like tweets and SMS
  > messages. Another interesting future direction is to study the relationship of authorship
  > verification with other author identification tasks, like author clustering (grouping documents
  > by authorship) and author diarization (segmenting a multi-author [document])."
- Cross-genre is harder than cross-topic: **Dutch (cross-genre) was the most difficult part**;
  Bagnall's own notebook explains the Dutch failure as "a drastic genre difference between the
  known and unknown texts."

**Bagnall 2015 system paper** `[OPENED]` — "Author Identification using multi-headed Recurrent
Neural Networks. Notebook for PAN at CLEF 2015".
URLs: https://downloads.webis.de/pan/publications/papers/bagnall_2015.pdf · arXiv:1506.04891
- Architecture: a **character-level RNN language model** whose output layer is split into several
  independent softmax sub-models, **one per author**, sharing a common recurrent layer. Each head
  is trained predominantly on one author's corpus so the shared recurrent layer models the
  language as a whole without over-fitting on a corpus of a few thousand characters.
- The author notes the training corpus is "100 mini-corpora for each language", each with **1 to 5
  documents** by a single author, amounting to "**a few thousand characters**".
- **Ablation worth citing**: with the recurrent layer accidentally reduced to zero (i.e. only
  character unigram biases per author), training AUC was **0.85 (English)** and **0.91 (Spanish)** —
  "one of the best training results" for English. This is direct evidence that **surface character
  distributions alone carry most of the signal** in this task.
- arXiv abstract claims the method "came first overall with an average AUC greater than .80."

### 1.6 PAN 2016 — author clustering and author diarization `[OPENED via overview paper]`
**Rosso, Rangel, Potthast, Stamatatos, Tschuggnall & Stein, "Overview of PAN'16".**
URL: https://downloads.webis.de/pan/publications/papers/rosso_2016.pdf (task pages:
https://pan.webis.de/clef16/pan16-web/author-diarization.html, https://pan.webis.de/clef16/pan16-web/author-clustering.html)

- **Author clustering** (single-authored documents, up to 100 per collection, same language and
  genre, varying topic and length, **number of distinct authors NOT given**). 8 submissions.
  Complete clustering scored with **BCubed P/R/F**; authorship-link ranking with **MAP**.
  | Participant | B3 F | B3 Recall | B3 Precision | MAP |
  |---|---|---|---|---|
  | Bagnall | **0.8223** | 0.7263 | 0.9765 | 0.1689 |
  | Kocher | 0.8218 | 0.7215 | 0.9816 | 0.0540 |
  | Sari & Stevenson | 0.7952 | 0.7330 | 0.8927 | 0.0399 |
  | Zmiycharov et al. | 0.7684 | 0.7161 | 0.8521 | 0.0033 |
  | Gobeill | 0.7058 | 0.7669 | 0.7373 | 0.1146 |
  | **Baseline (random)** | **0.6666** | 0.7140 | 0.6412 | 0.0015 |
  | Kuttichira | 0.5881 | 0.7202 | 0.5122 | 0.0014 |
  | Mansoorizadeh et al. | 0.4008 | 0.8218 | 0.2804 | 0.0085 |
  | Vartapetiance & Gillam | 0.2336 | 0.9352 | 0.1947 | 0.0120 |
  Note the extremely low **MAP** across the board — authorship-link ranking is nearly unsolved.
  Note also that BASELINE-Singleton (all documents in their own cluster) guarantees BCubed
  precision of 1 by construction, which inflates the naive baseline.
- **Author diarization** — three variants: (a) traditional **intrinsic plagiarism detection**
  (one main author wrote **at least 70%** of the text, up to 30% intrusive, exactly two clusters);
  (b) diarization with a known number *n* of authors; (c) diarization with an **unknown** number
  of authors. **Only 2 teams participated.**
  | Variant | Winner | BCubed R / P / F |
  |---|---|---|
  | diarization, *n* known | Kuznetsov et al. | 0.46 / 0.64 / **0.52** |
  | diarization, *n* unknown | Kuznetsov et al. | 0.42 / 0.64 / **0.48** |
  | intrinsic plagiarism | Kuznetsov et al. | macro F **0.22** (2nd: 0.14) |
  → **Within-document multi-author analysis is essentially unsolved**, and the second-place
  intrinsic-plagiarism macro F is 0.14.

### 1.7 PAN 2017 — style breach detection and author clustering `[OPENED via overview + notebook]`
**Tschuggnall, Stamatatos, Verhoeven, Daelemans, Specht, Stein & Potthast, "Overview of the Author Identification Task at PAN 2017: Style Breach Detection and Author Clustering", CLEF 2017, CEUR-WS Vol-1866.**
URL: https://downloads.webis.de/publications/papers/tschuggnall_2017.pdf
(also "Overview of PAN'17", https://downloads-cf.webis.de/publications/papers/potthast_2017g.pdf, and task page https://pan.webis.de/clef17/pan17-web/style-change-detection.html)

- **Task**: given a document, determine whether it is multi-authored and, if so, **locate the
  borders** where authorship changes. Borders may only occur **at the end of sentences**.
- **Corpus**: built from **Webis-TRC-12** (documents on 150 TREC Web Track topics, written by
  hired professional writers from search results; each distinct source treated as a distinct
  author). **Training = 187 documents, test = 99 documents.**
- Varied parameters: number of borders **0–8**; collaborating authors **1–5**; average segment
  length **~30–2,500 words**; document length **~200–6,000 words**; borders at paragraph ends or
  within paragraphs; segment lengths uniform or random.
- Test-set composition: **0 breaches 20 (20%); 1–3 breaches 44 (44%); 4–6 breaches 25 (25%);
  7–8 breaches 10 (10%)**. Collaborating authors **2–3 = 44 (44%)**, **4–5 = 35 (35%)**. Document
  length **1,000–2,000 words = 50 (51%)**.
- **Measures**: **WindowDiff** (error rate, 0 = perfect) and **WinPR** (WinP/WinR); final ranking
  by **WinF**.
- **Official test results — only 3 submissions**:
  | Team | WinF | WinP | WinR | WindowDiff | Runtime |
  |---|---|---|---|---|---|
  | **OPI-JSA (Karas et al.)** | **0.322601** | 0.314656 | 0.585617 | 0.545648 | 00:01:19 |
  | khan17 | 0.288795 | 0.399004 | 0.487075 | 0.479990 | 00:02:23 |
  | kuznetsova17 | 0.277264 | 0.371108 | 0.542527 | 0.529496 | 00:20:25 |
- **Conclusion (verbatim)**: "Although all three approaches achieved a better performance than
  the simple random baseline, only one of them could exceed a slightly enhanced baseline, which is
  also based on random guesses." And: "results indicate that intrinsically segmenting a text into
  distinct authorial components is hard to be tackled."
- Two structural observations relevant to "style varies by recipient": Karas et al. **only treat
  paragraph ends as possible borders** (creating artificial fixed-length paragraphs when none
  exist) and their performance **decreases drastically for segment lengths over 500 words** but is
  highest for documents with **very short segments**. Document length matters: they get
  "best results for the majority of documents within 1,000–2,000 words."

### 1.8 PAN 2018 — cross-domain attribution and binary style change `[OPENED via overview + tables]`
**Kestemont, Tschuggnall, Stamatatos, Daelemans, Specht, Stein & Potthast, "Overview of the Author Identification Task at PAN-2018: Cross-domain Authorship Attribution and Style Change Detection".**
URLs: https://downloads.webis.de/pan/publications/papers/kestemont_2018.pdf ·
https://ceur-ws.org/Vol-2125/invited_paper_2.pdf · (PAN 2018 overview with tables mirrored at
https://riunet.upv.es/bitstreams/87712116-50cf-4996-a2c6-293d7eba90b9/download)

**Task A — cross-domain (cross-fandom) authorship attribution.** Fanfiction, **5 languages**
(English, French, Italian, Polish, Spanish). **11 submissions.** Metric: **macro F1**.
| Submission | Overall | English | French | Italian | Polish | Spanish | Runtime |
|---|---|---|---|---|---|---|---|
| **Custódio & Paraboni** | **0.685** | 0.744 | 0.668 | 0.676 | 0.482 | 0.856 | 00:04:27 |
| Murauer et al. | 0.643 | 0.762 | 0.607 | 0.663 | 0.450 | 0.734 | 00:19:15 |
| Halvani & Graner | 0.629 | 0.679 | 0.536 | 0.752 | 0.426 | 0.751 | 00:42:50 |
| Mosavat | 0.613 | 0.685 | 0.615 | 0.601 | 0.435 | 0.731 | 00:03:34 |
| Yigal et al. | 0.598 | 0.672 | 0.609 | 0.642 | 0.431 | 0.636 | 00:24:09 |
| Martín dCR et al. | 0.588 | 0.601 | 0.510 | 0.571 | 0.556 | 0.705 | 00:11:01 |
| **PAN18-BASELINE** | **0.584** | 0.697 | 0.585 | 0.605 | 0.419 | 0.615 | 00:01:18 |
| Miller et al. | 0.582 | 0.573 | 0.611 | 0.670 | 0.421 | 0.637 | 00:30:58 |
| Schaetti | 0.387 | 0.538 | 0.332 | 0.337 | 0.388 | 0.343 | 01:17:57 |
| Gagala | 0.267 | 0.376 | 0.215 | 0.248 | 0.216 | 0.280 | 01:37:56 |
| López-Anguita et al. | 0.139 | 0.190 | 0.065 | 0.161 | 0.128 | 0.153 | 00:38:46 |
| Tabealhoje | 0.028 | 0.037 | 0.048 | 0.014 | 0.024 | 0.018 | 02:19:14 |
By candidate-set size (macro F1): Custódio & Paraboni **0.648 (20 authors), 0.676 (15), 0.739
(10), 0.677 (5)**; PAN18-BASELINE **0.546 / 0.532 / 0.595 / 0.663**.
Polish is hardest; English and Spanish easiest.
**The headline methodological lesson:** "simple approaches based on character/word n-grams and
well-known classification algorithms are much more effective in this task than more sophisticated
methods based on deep learning and linguistic analysis of texts." The winner is an **ensemble of
three simple character/word n-gram approaches plus a "distorted version of texts"**; third place
is **compression-based**. "methods using simple and language-independent features are more
effective in this task." Statistical testing: the winner is significantly better than everyone
except its immediate runner-up (p = 0.183); differences between neighbouring ranks are mostly not
meaningful.

**Task B — style change detection.** Task **relaxed** from PAN 2017's border-finding to a single
binary question: **is this document written by one author or more than one?** Dataset built from
the **StackExchange Q&A network** so that multi-author documents share a topic. Sizes:
**2,980 training problems, 1,492 validation problems, 1,352 test problems**, with the number of
documents containing style changes **equal to** the number containing none.
**Result**: "With an accuracy of nearly 90%, **Zlatkova et al.** achieved the best result over all
documents across all topics and subtopics. **All approaches outperformed all baselines.**" The two
best systems needed significantly more runtime (ensemble technique; parse-tree generation).
Finding: the **simplest compilation (two authors, one style change) is the most challenging type**,
and performance is "related to the number of authors involved, i.e., the more authors, the better."

---

## 2. Verification as provenance: the "one-class" framing and its key papers

### 2.1 The fundamental-problem framing
- **Koppel & Schler 2004, "Authorship verification as a one-class classification problem", Proc.
  ICML 2004, pp. 1–7** — introduced the **unmasking** method. `[SNIPPET]` (cited and characterised
  in the JMLR paper and in Bevendorff et al. 2019; the ICML paper itself was not opened).
- **Koppel, Schler & Argamon 2009** — the canonical statement that verification is the
  *fundamental* problem; see §5 for the numbers.
- **Koppel & Winter 2014** — the canonical "any attribution problem reduces to a pair" framing;
  see §2.2.
- PAN's own framing (PAN 2013 paper): "authorship verification is the special case where the set
  of candidate authors is a singleton... either he wrote the unknown document(s) or 'someone else'
  did, where 'someone else' could be anyone else in the universe." And: "every author
  identification problem with multiple candidate authors can be transformed to a set of author
  verification problems."
- PAN 2015's framing: "the authorship verification task corresponds to a **one-class
  classification problem**, where the samples of known authorship by the author in question form
  the target class. All texts written by other authors are viewed as the outlier class, a huge and
  heterogeneous class, which renders finding representative samples difficult."
- **Why ROC-AUC**: PAN 2014/2015 use AUC because it "tests the ability of methods to rank scores
  appropriately, assigning low values to negative problems and high values to positive problems";
  it is threshold-free, which matters when the same-author prior is unknown. PAN 2013 used
  **F1/recall/precision** + a separate AUC ranking.

### 2.2 Koppel & Winter, "Determining if two documents are written by the same author" `[OPENED]`
**Moshe Koppel & Yaron Winter. Journal of the Association for Information Science and Technology
(JASIST) 65(1):178–187, 2014** (published online 2013-10-23). DOI 10.1002/asi.22954.
Preprint opened: https://u.cs.biu.ac.il/~koppel/papers/impostors-journal-revised2-140213.pdf

- **Problem**: given a pair of documents X, Y — possibly **short** — were they written by the same
  author? Explicitly framed as the reduction target for "almost any conceivable authorship
  attribution problem", and as an **open-set** problem ("the reverse is not true").
- **Corpus**: full output of several thousand bloggers from blogger.com; the average blogger has
  **38 posts over several years**. X = the **first 500 words** by a blogger; Y = the **last 500
  words** (maximising the time gap; for same-author pairs X and Y are **never in the same post**).
  **500 pairs: 250 same-author, 250 different-author**; no blogger appears in more than one pair.
  Crucially **essentially unsupervised** — no labelled examples of any of the corpus authors.
- **Features**: the **100,000 most frequent "space-free" character 4-grams**, tf·idf. The authors
  justify character n-grams over bag-of-words/function words/POS n-grams by citing
  Grieve 2007, Plackias & Stamatatos 2008, Luyckx & Daelemans 2010, Escalante et al. 2011 as
  showing "simpler feature sets such as character n-grams are at least as effective as the
  alternatives and often even more effective", plus the advantage of being language-independent.
- **Baselines on the 500-pair task (all at 500 words/doc)**:
  | method | test accuracy |
  |---|---|
  | cosine similarity, dev-tuned threshold | **70.6%** |
  | min-max similarity, dev-tuned threshold | **74.2%** |
  | supervised linear SVM on diff(X,Y) vectors, 1,000 labelled training pairs from disjoint authors | **79.8%** |
  (the 79.8% SVM was "the strongest result we obtained, using a variety of kernels and parameter
  settings and various feature sets, including bag-of-words, function words and others")
- **Many-candidates subroutine**: with **5,000 candidates × 500 words**, plain min-max nearest
  neighbour assigns **32.5%** of snippets correctly (chance 0.02%). Feature-subsampling
  (k = 100 iterations, each on a random half of the features; score(A) = proportion of times A is
  the top match) with threshold σ\* = 0.80 gives, for **500 candidates, 90.2% precision at 22.2%
  recall**. False-attribution rate for snippets whose author is **not** in the candidate set at
  σ\* = 0.80: **3.7% (5,000 candidates), 5.5% (500), 8.4% (50)** — fewer candidates paradoxically
  produce *more* false positives. More iterations do not help (22.3% recall at 90% precision with
  1,000 iterations vs 22.2% at 100).
- **The Impostors method for verification**: (1) generate impostors Y₁…Y_m; (2) scoreX(Y) = number
  of feature-set choices (out of 100) for which sim(X,Y) > sim(X,Y_i) for all i; (3) repeat
  symmetrically for scoreY(X); (4) if the average exceeds σ\*, declare same-author.
  Impostor universes: **Fixed** (random English Google queries), **On-the-fly** (50 sets of 3–5
  random medium-frequency words from Y as Google queries, top 25 results each), **Blogs** (texts
  from other bloggers — same genre). Protocol: compute min-max similarity to Y over the universe,
  take the **m most similar as potential impostors**, then **randomly select n** actual impostors.
- **Headline results (500-word documents, 500 pairs)**:
  | method | accuracy |
  |---|---|
  | Impostors, **Blogs** universe | **87.4%** |
  | Impostors, **On-the-fly** universe | **83.2%** |
  With the Blogs universe, **recall at precision = 0.9 is 82.5%** for the same-author class and
  **66.0%** for the different-author class. Operating point intuition: with a 0.5 prior, "a score
  above 0.12 indicates that the chance that X and Y are by different authors is less than 10% and a
  score below 0.02 indicates that the chance that X and Y are by the same author is less than 10%."
  Results are insensitive to m (100–1,000) and n (10–100): Blog impostors 85.2–87.7%, On-the-fly
  80.8–83.2%.
  Macro-averaged F1 vs. the same-author prior: prior 0.1 → **86.9**; 0.3 → **87.5**; 0.5 →
  **87.4**; 0.7 → **83.7**; 0.9 → **75.8**.
- **Length sensitivity (directly relevant)**: "all our results are for pairs of documents that are
  of length 500. If we have longer documents, results are even stronger. In fact... the accuracy of
  the impostors method increases as the length of the input documents increases. For documents of
  length **1500 or greater** [results are even better]."
- **Stated limitation**: "empirical studies (**Sanderson & Guenter, 2006**) have shown that
  unmasking is ineffective for short input documents (**less than 10,000 words**)." The authors
  also note that unmasking requires chunks of "at least a few hundred words" to be statistically
  representative.
- **Caveat the authors themselves state**: optimal σ\* was chosen on a development set built by the
  same methodology on a disjoint set of bloggers, so the method is "technically not completely
  unsupervised."

### 2.3 Halvani, Winter & Graner — compression-based verification `[OPENED via arXiv/ARES]`
**"Authorship Verification based on Compression-Models", arXiv:1706.00516**; published as
**"On the Usefulness of Compression Models for Authorship Verification", ARES 2017**,
DOI 10.1145/3098954.3104050.
URLs: https://arxiv.org/pdf/1706.00516 · https://doi.org/10.1145/3098954.3104050

- **Three components only**: a compression algorithm, a dissimilarity measure, and a threshold.
  **No ML, no NLP, no feature engineering, no hyper-parameter optimisation, no external documents.**
  This makes it the cheapest possible baseline for a "does this feel like the same person" check.
- 60 runs over the four PAN training corpora: compressors **{PPMd, GZip, BZip2, Zip, LZW}** ×
  measures **{NCD, CBC, CLM}**. **PPMd + CBC** wins on average AUC. Zip is **at least twice as
  fast** as PPMd.
- Threshold is set at the **equal error rate (EER)** on a training corpus with balanced
  true/false authorships.
- **Runtime**: a corpus of **500 AV cases in "few seconds"** on an Intel Core i5-3210M / 16 GB
  laptop. Against PAN 2015 they outperform **all** participating teams except Bagnall, and the
  meta-model — in **7 seconds** where Bagnall needed **more than 21 hours**.
- Successfully solved many PAN 2015 problems where a document was as small as **1.56 KByte**.
- Against PAN 2014 (CPAN14noEval) they rank among the three best; Khonji & Iraqi beat them on AUC
  but at much higher runtime.
- They also report that **GLAD** achieved the highest AUC of **0.937** on CAmazonEval across all
  methods on all seven corpora, and that GLAD's weakness was CPAN15Eval, which they attribute to
  that corpus's shape (one known vs one unknown document, average **536 words** per document).
- **Related Halvani notebooks**:
  - PAN 2013 (Halvani, Steinebach & Zimmermann): **F1 0.718** overall, rank 2, best on Spanish
    **0.840**, runtime **8,362** — the notebook is at CEUR Vol-1179.
  - PAN 2014 **VEBAV** (Halvani & Steinebach), CEUR-WS Vol-1180,
    https://ceur-ws.org/Vol-1180/CLEF2014wn-Pan-HalvaniEt2014.pdf `[OPENED]`: preprocessing
    concatenates all known documents into one and re-splits into **ℓ chunks**, with
    **ℓ = 5 if length > 15,000 characters, otherwise ℓ = 3**. Their AUC·c@1 was "very low"; the
    authors explicitly flag the un-optimised probability score as the cause.
  - PAN 2015 **"A Generic Authorship Verification Scheme Based on Equal Error Rates"**,
    https://downloads.webis.de/pan/publications/papers/halvani_2015.pdf `[OPENED]`, gives a clean
    statement of PAN corpus structure: "The number of known documents in each problem ρ varies
    from **one to five** documents. The lengths of the texts in these corpora vary between **a few
    hundred and a few thousand words**. The distribution of true and false authorships in each
    corpus is **uniform**."

### 2.4 Fréry, Largeron & Juganaru-Mathieu (`extractive` / decision-tree line) `[OPENED]`
**"UJM at CLEF in Author Identification based on optimized classification trees", CLEF 2014 Working
Notes, CEUR-WS Vol-1180.** URL: https://ceur-ws.org/Vol-1180/CLEF2014wn-Pan-FreryEt2014.pdf
- Decision trees (**CART**) over several text representations, learned per training corpus.
- **Overall AUC 70.7%, c@1 68.4% → final 0.484 = 2nd place, and the best c@1 of all 13
  submissions**; 1st/13 on English essays.
- Notable failure mode they report: "we lost significant accuracy for the English novels corpus
  (**near 30% of loss**)" — i.e. strong train/eval transfer gaps even within a language.

### 2.5 A concrete verification corpus for reference `[SNIPPET]`
**Halvani, "Enron Authorship Verification Corpus", Mendeley Data, DOI 10.17632/n77w7mygwg.1 (2017).**
- **80 authorship verification cases**, evenly distributed true/false.
- Each case = **exactly 5 documents**: **4 known + 1 questioned**.
- Documents are **near-equal length, 3–4 kilobytes** each.
- Documents are **aggregated from short mails of the same author** "in order to have a sufficient
  length that captures the author's writing style" — **precedent for concatenating short messages
  into pseudo-documents**, exactly the operation a WeChat corpus needs.
- Preprocessing: de-duplication, URL removal, newline/tab removal, UTF-8 normalisation, blank
  collapsing; **all headers and signatures removed**.

---

## 3. SHORT TEXT: how much text is actually needed?

This is the core question. The literature gives **three families of thresholds**: (i) the
classical "6,500 / 10,000 words" rule of thumb, (ii) controlled length-sweep studies on literary
texts, and (iii) message-count thresholds from Twitter/SMS/chat.

### 3.1 The classical word-count thresholds — and where they come from

| claim | figure | source | where it comes from |
|---|---|---|---|
| 19th century | "difficult to determine the authorship of a document of **fewer than 1,000 words**" | Layton, Watters & Dazeley 2010 | historical summary in the paper's intro |
| 1990s | "this value had decreased to **less than 500 words**" | Layton et al. 2010 | same |
| early 21st century | "possible to determine the authorship of a document in **250 words**" | Layton et al. 2010 | same |
| **the ~6,500-word recommendation** | **6,500 words** as the lower bound for reliable attribution | **Rao & Rohatgi, "Can pseudonymity really guarantee privacy?", USENIX Security 2000** | reported secondhand in *Humanities Data Analysis* ("On the basis of a contemporary English dataset (**19,415 articles by 117 authors**), Rao and Rohatgi (rather conservatively) suggested **6,500 words** as the lower bound") and again in the adversarial-stylometry replication ("only a modest amount of pre-existing writing needs to be collected... (Rao and Rohatgi, 2000; Eder, 2015)"). The USENIX paper itself was **not opened** — treat 6,500 as **secondary-sourced but doubly corroborated**. |
| "a reliable minimum for an authorial set" | **10,000 words per author** | **Burrows 2007**, quoted in Luyckx & Daelemans 2011 | "Traditionally, 10,000 words per author is regarded to be 'a reliable minimum for an authorial set' (Burrows, 2007)." |
| minimum **training** size | **5,000 words** | **Sanderson & Guenter 2006**, quoted in Luyckx & Daelemans 2011 and in Bevendorff et al. 2019 | "Sanderson and Guenter (2006)... find that **5,000 words in training** can be considered a minimum requirement"; and Bevendorff et al.: "their own model produced acceptable results with a **minimum of 5,000 words per training text**." |
| the 6,500 figure as a **practical collection requirement** | **≥6,500 words per participant** of *formal* writing, with samples "**less than 500 words**" explicitly excluded | **Brennan, Afroz & Greenstadt 2012, "Adversarial Stylometry", ACM TISSEC 15(3):1–22** | quoted verbatim in the replication study arXiv:2208.07395: "each participant uploaded **at least 6,500 words of formal writing**. The participants were instructed not to upload writing containing extensive 'dialog/quotations' or samples '**less than 500 words**, laboratory and other overly scientific reports, Q&A-style samples such as exams, [or] anything written in another person's style'." |
| with a large reference corpus | **1,000–2,000 words** suffices | **Eder 2017**, quoted in the CLS Infra survey | "from 5000 words as a minimum in a scenario where all quantified texts are of the same size (**Eder 2013a**), to **1000-2000 words** in a scenario where a much larger reference or training corpus is available (**Eder 2017**)" |

**Important honesty note for the survey**: the widely-quoted "~6,500 words" is **not** a
PAN-derived or modern-deep-learning-derived number. It is a **year-2000 privacy result (Rao &
Rohatgi)** about pseudonymity, i.e. an *adversarial lower bound on what an attacker needs*, and it
was subsequently hardened into a data-collection rule by Brennan et al. 2012. It should be cited
that way, not as a modern finding.

### 3.2 Eder — the most rigorous length sweep `[SNIPPET]`
**Maciej Eder, "Does Size Matter? Authorship Attribution, Small Samples, Big Problem",
Digital Scholarship in the Humanities 30(2):167–182 (2015); earlier version at DH2010.**
URL (abstract/paper): https://dh2010.cch.kcl.ac.uk/academic-programme/abstracts/papers/pdf/ab-744.pdf

- Corpora: **63 English novels** plus Polish, German, Hungarian, French novels; English epic
  poetry; Latin poetry (Ancient and Modern); Latin prose (non-fiction); Ancient Greek epic poetry.
- Procedure: for each text, **500 randomly chosen single words were concatenated into a sample**;
  the procedure was repeated for **600, 700, 800, …, 20,000 words** per sample, using classical
  **Burrows's Delta**.
- **Results**: the curve "climbing up very quickly, tends to stabilize at a certain point... It
  becomes quite obvious that **samples shorter than 5,000 words provide a poor 'guessing'**,
  because they can be immensely affected by random noise. **Below the size of 3,000 words, the
  obtained results are simply disastrous.**"
- Critical point across corpora: **between 5,000 and 10,000 words**, with no significant difference
  between inflected and non-inflected languages. Two exceptions: English and Latin **poetry**
  stabilised at **~3,500 words**; **Latin prose** at **~2,500 words**.
- Robustness claim: "the shape of all the curves, as well as the point where the attributive
  success rate becomes stable, are quite identical" for Delta, Delta Prime, Cluster Analysis and
  Multidimensional Scaling — i.e. **method-independent**. Also invariant to culling, number of most
  frequent words, and pronoun deletion, although settings change the *level* (up to 100% for the
  best).
- Author's own caveat: "using 2500-word samples will hardly provide a reliable result, to say
  nothing of shorter texts."

### 3.3 Sanderson & Guenter 2006 — short-text verification, and why unmasking fails there `[SNIPPET]`
**"Short text authorship attribution via sequence kernels, Markov chains and author unmasking: An
investigation", EMNLP 2006, pp. 482–491.** ACL Anthology: https://aclanthology.org/W06-1657.pdf
DOI 10.3115/1610075.1610142

- **50 authors**, each covering **several topics**; training and test material per author varied
  from **~300 to 5,000 words**. Verification (two-class) setup rather than closed-set.
- **Key findings, quoted**:
  - "the amount of **training** material has more influence on discrimination performance than the
    amount of **test** material; about **5000 training words are required** to obtain relatively
    good performance when using between **1250 and 5000 test words**."
  - "the author unmasking approach is **less useful when dealing with relatively short texts**,
    due to the unmasking effect being considerably less pronounced than for long texts and also
    due to different-author unmasking curves having close similarities to the same-author curves."
- Their unmasking short-text configuration: **5,000-word sections**, **100 pre-selected words**,
  **200-word chunks**. Their long-text replication kept Koppel & Schler's **500-word chunks**,
  **10-fold CV**, **6 features removed per iteration**, **250 pre-selected words**.
- Optimum chunk size: **~4,000 characters** for word-based approaches; roughly an order of
  magnitude smaller for character-based approaches (they used **500-character** chunks vs
  **4,000-character** chunks in a head-to-head).
- This is the paper that **established that classical unmasking does not transfer to short text** —
  a load-bearing citation for anyone arguing that "does this feel like the same person" needs a
  different instrument at message scale.

### 3.4 Luyckx & Daelemans 2011 — author-set size × data-size interaction `[SNIPPET]`
**"The effect of author set size and data size in authorship attribution", Literary and Linguistic
Computing 26(1):35–55.** PDF: https://www.clips.uantwerpen.be/~walter/papers/2011/ld11.pdf

- Repeats the tradition: **10,000 words/author** = "a reliable minimum for an authorial set"
  (Burrows 2007); **5,000 training words** minimum (Sanderson & Guenter 2006).
- **PERSONAE** corpus, **145-way** attribution: 10% of the data = **one fragment of 140 words per
  candidate author** ("about the size of a (long) e-mail") → **3% accuracy**; 90% of the data →
  **~10% accuracy**.
- **AAAC_A**, **13-way**: 10% training data → **27% accuracy** with character trigrams; 90% →
  **50% accuracy**.
- **ABC_NL1**: documents in nine topics per author totalling **~9,000 words per author**; least
  sensitive to data size; character n-grams best throughout.
- Positive result: "authorship attribution with a small set of training data — **about 1,200 words
  per author** — is **up to standards** when comparing with performance on larger sets of data";
  10% of PERSONAE ≈ **140 words per author** is "a (long) e-mail".
- Best feature types across all three corpora: **character trigrams** and lexical features.
- Also notes the strong **topic effect** (citing Mikros & Argiri 2007), and Stamatatos 2007 on
  class imbalance: "the best method uses many short text samples for minority classes and less but
  longer ones for the majority classes" — i.e. **many short messages can substitute for long texts.**

### 3.5 Message-count thresholds: Twitter

**Layton, Watters & Dazeley 2010, "Authorship Attribution for Twitter in 140 Characters or Less",
CTC '10 (2nd Cybercrime and Trustworthy Computing Workshop), pp. 1–8, IEEE.**
DOI 10.1109/ctc.2010.17 `[SNIPPET]`
- Uses the **SCAP methodology** (Frantzeskou et al. 2007) with character n-grams.
- **Central threshold claim**: "we show that **120 tweets per user is an important threshold**, at
  which point **adding more tweets per user gives a small but non-significant increase in
  accuracy**." Authorship can be determined "at rates significantly better than chance for
  documents of 140 characters or less", and remains significantly above chance even when features
  such as the recipient of directed messages are disallowed.

**Schwartz, Tsur, Rappoport & Koppel 2013, "Authorship Attribution of Micro-Messages", EMNLP 2013,
pp. 1880–1891. ACL Anthology: https://aclanthology.org/D13-1193.pdf** `[SNIPPET]`
- Dataset: **~9,000 Twitter users with up to 1,000 tweets each**; a **single tweet** is the test
  document. 10 groups of 50 users for the training-size sweep.
- Tweet length statistics (useful for calibrating "one message"): tweets average **14.2 words**
  (vs **20.9** for English web data), with a length standard deviation of **6.4** (vs **21.4**).
- **Headline numbers**:
  - 1,000 authors × 200 training tweets → **30.3%** accuracy (random baseline **0.1%**).
  - 50 authors × 50 training tweets → **50.7%** (reported as **49.5%** in the results section).
  - 50 authors × 1,000 training tweets → **71.2%** in standard classification.
  - **>91% accuracy at ~60% recall** with the **"don't know"** option enabled.
  - Precision/recall: ">90% precision while still maintaining a relatively high recall (from
    **~35% recall for 50 tweets per author** up to **>60% recall for 1,000 tweets per author**)".
  - Even at 1,000 authors: precision **90% at ~18% recall** and **70% at ~30% recall**.
- Feature result: **word n-grams improve over character-n-gram-only by ~3% averaged** across all
  settings; **flexible patterns** (which "capture the context in which **function words** are
  used") give a further **6.1% improvement over the then state of the art**; **k-signatures**
  (features present in ≥k% of one author's samples and no other author's) are typical of many
  authors, and a substantial portion of tweets contain at least one.

**Shrestha, Sierra, González, Montes-y-Gómez, Rosso & Solorio 2017, "Convolutional Neural Networks
for Authorship Attribution of Short Texts", EACL 2017 Vol. 2 (short papers), pp. 669–674.**
ACL Anthology: https://aclanthology.org/E17-2106/ (PDF https://aclanthology.org/E17-2106.pdf)
`[OPENED via PDF]`
- Dataset: the Schwartz et al. set (~9,000 users, up to 1,000 tweets each), same splits.
- **Accuracy vs number of authors** (single tweet as test document):
  | # authors | CNN-2 | CNN-1 | SCH (Schwartz) | CHAR (char 2,3,4-gram + LR) | LSTM-2 | CNN-W |
  |---|---|---|---|---|---|---|
  | 100 | **0.506** | 0.508 | 0.425 | 0.412 | 0.338 | 0.241 |
  | 200 | 0.481 | 0.473 | 0.411 | 0.409 | 0.335 | 0.208 |
  | 500 | 0.422 | 0.417 | 0.355 | 0.342 | 0.298 | 0.161 |
  | 1,000 | **0.365** | 0.359 | 0.303 | 0.291 | 0.248 | 0.127 |
- **Accuracy vs number of training tweets per author**:
  | # tweets | CNN-2 | CNN-1 | SCH | CHAR | LSTM-2 | CNN-W |
  |---|---|---|---|---|---|---|
  | 500 | **0.724** | 0.717 | 0.672 | 0.655 | 0.597 | 0.509 |
  | 200 | 0.665 | 0.665 | 0.614 | 0.585 | 0.528 | 0.460 |
  | 100 | 0.613 | 0.617 | 0.565 | 0.517 | 0.438 | 0.417 |
  | 50 | 0.542 | **0.562** | 0.507 | 0.466 | 0.364 | 0.366 |
- They also quote Bagnall 2015 as "the best-performing system for the PAN 2015 author identification
  task with a **macro-averaged AUC of 0.628**".
- Their loss model is a **CNN over character n-grams** with `n ∈ {1,2,3}` on embeddings; filters
  `w ∈ {3,4,5}`, 500 units each, max pooling.
- Stated motivation that matters for the survey: "Previous work has shown that it is difficult for
  any AA system to maintain the same performance with shorter texts (**Koppel and Winter, 2014**)."

**Alonso-Fernandez, Belvisi, Hernandez-Diaz, Muhammad & Bigun, "Writer Identification Using
Microblogging Texts for Social Media Forensics", arXiv:2008.01533.** `[SNIPPET]`
- Two databases: **93 authors** and **3,957 authors**. Tweets ≤140 chars. Author-set sizes 100,
  500, 1,000, **1,950**; enrolment/test tweets swept from 1,000 down to **5**.
- Results: with **>500 training tweets**, **Rank-5 > 80%** with only a few dozen test tweets, even
  with several thousand authors; **97–99% Rank-1** when there are only a few hundred authors and
  >500 tweets for enrolment and testing. With **10–20 training tweets**, the candidate search space
  can still be diminished by **9–15%** while keeping a high chance the true author is in the
  candidate list. Rank-5 falls **below 35%** at 1,950 authors if training drops to a few dozen
  tweets.
- **Verification (EER)**: with few training/test tweets the **EER is above 20–25%**; it drops to
  **<15%** if hundreds of training tweets are available. Author-set size has **much less** impact
  on verification than on identification.
- Useful summary of others (all as reported by this paper):
  - POS-tag n-grams, **10,000 Twitter users**, **120 tweets/user** (90 train / 30 test) → **53.2%**
    accuracy (ref [28] — this is likely Okuno et al. or a similar early work; the reference number
    is verified, the identity is `[UNVERIFIED]`).
  - SMS, **81 authors**, 2,000 messages, **max 50 messages/author** → **20.25%** accuracy.
  - SMS, **70 persons**, **≥50 SMS each across a year**, unigram word counts: with 20 users having
    **>500 SMS each** for training → **~88%** accuracy when 20 SMS/user are used for testing;
    with only **1 SMS** for testing → **~41%**; with **100 training messages** → "barely goes above
    **61%**" using 20 test SMS; with **50 training messages** → "goes **below 48%**". The authors of
    that study acknowledge the results "may be positively biased since they deliberately chose the
    SMSs having the maximum length".
  - Char/word/POS n-grams with several classifiers (the Schwartz-style sweep): with **500 training
    tweets** best accuracy ranges **57% (50 users)** to **35% (1,000 users)**; with only **50
    training tweets** those fall to **46%** and **28%**.
- Feature permanence: all features degrade as the gap between training and test tweets grows,
  though at different rates; extraction cost is **milliseconds per tweet**; comparison is
  **microseconds**.

**Belvisi, Muhammad & Alonso-Fernandez 2020, "Forensic Authorship Analysis of Microblogging Texts
Using N-Grams and Stylometric Features", IEEE IWBF 2020.** DOI 10.1109/iwbf49977.2020.9107953;
arXiv:2003.11545 `[OPENED via arXiv HTML]`
- Self-captured DB of **40 users**, **120–200 tweets per user** (≤280 chars). Profile-based
  (all of a user's tweets concatenated — chosen *because* the texts are short).
- Accuracy **92%–98.5%** depending on feature family: **idiosyncratic 98.5%** (misspellings,
  slang, emoji), **n-grams 97%** (character n=3 and n=4 identical, Cosine), word n-grams **94–95%**,
  lexical/structural **92–96%**.
- Methodological note directly relevant to code-mixed informal text: content-specific features were
  **excluded** (random, topicless tweets) and **syntactic features were judged unreliable** "given
  the length of a tweet... due to the lack of enough information to establish an author's profile."
  They add non-standard features: average presence of URLs or tagged users.
- The 98.5% must be read against **40 authors**. Contrast with 0.365 for 1,000 authors in
  Shrestha et al. — **candidate-set size is the dominant variable.**

### 3.6 A consolidated short-text table (for the survey)

| text unit | setting | best reported | source |
|---|---|---|---|
| 140-char tweet, single | 1,000 authors, 200 training tweets | **30.3%** (chance 0.1%) | Schwartz et al. 2013 |
| 140-char tweet, single | 50 authors, 50 training tweets | **50.7%** | Schwartz et al. 2013 |
| 140-char tweet, single | 50 authors, 1,000 training tweets | **71.2%** (91% at 60% recall with abstention) | Schwartz et al. 2013 |
| single tweet (140) | 100 / 500 / 1,000 authors | **0.506 / 0.422 / 0.365** | Shrestha et al. 2017 |
| 120 tweets/user | 10,000 Twitter users | **53.2%** | reported in arXiv:2008.01533 |
| ~120–200 tweets/user | 40 users | **92–98.5%** | Belvisi et al. 2020 |
| ≤140-char tweets | 1,950 authors, >500 training tweets | **Rank-5 > 80%**; verification EER **<15%** | arXiv:2008.01533 |
| SMS, small sets | 28 users, 1–5 gram sizes | **65–72%** | Mohan, Baggili & Rogers 2010 |
| SMS | 81 authors, ≤50 msgs/author | **20.25%** | reported in arXiv:2008.01533 |
| SMS | 70 persons, ≥50 msgs each | **~88%** (20 test SMS, >500 train SMS); **~41%** with 1 test SMS | reported in arXiv:2008.01533 |
| IM/chat turn | 77 individuals, dyadic chat | **nAUC 89.5%**, rank-1 29.2% | Segalin et al. 2012 |
| IRC chat logs | hundreds of authors | **up to 95%** | Inches, Harvey & Crestani 2013 |
| multiparty game chat | 978 users | **~75% rank-1** | Küçükyılmaz et al. 2016 |
| WhatsApp (Hinglish) | 4 authors, 76,000 words | **95.079%** (SVM, char 3-gram) | Sharma, Nandan & Ralhan 2018 |
| Chinese Twitter (Weibo-style) | 10 authors × 100 tweets | **20.52%** (k-means); 44.53% at 3 authors | URTC 2016 |
| single Weibo post (gender, not authorship) | per-post | **~62.8%**; ~70% for 16–40-word posts; **humans 55.5–64.0%** | RANLP 2017 |
| 500-word blog pair, verification | impostors, blog universe | **87.4%** | Koppel & Winter 2014 |
| 200-word snippet, 10,000-author open set | meta-learned | **86% precision at 30% recall** | Koppel, Schler & Argamon 2009 |
| 500-word snippet, 10,000-author open set | meta-learned | **87% precision at 40% recall**; 94% at 30% | Koppel, Schler & Argamon 2009 |

**The synthesis for a ~104k-message WeChat corpus**: no source supports a hard per-message
threshold. The defensible reading is (a) **per-message attribution is near-impossible**
(human ceiling ≈ 60% on a single post, §5.4); (b) **aggregation is what works** — 140 words/author
is already informative in a 145-way task, ~1,200 words/author is "up to standards", and 5,000
training words is the classical minimum; (c) the modern **abstention-capable** regime
("don't know" / impostors at σ\*) buys high precision on a minority of cases and is the honest
framing for a clone-verification tool.

---

## 4. Chat / WhatsApp / SMS / instant messaging — real chat logs

### 4.1 Inches, Harvey & Crestani 2013 — IRC chat logs `[SNIPPET]`
**"Finding Participants in a Chat: Authorship Attribution for Conversational Documents",
SocialCom 2013, pp. 272–279.** DOI 10.1109/socialcom.2013.45
- Claimed as **the first study of authorship attribution for conversational documents (IRC chat
  logs) using statistical models**.
- "We experimentally demonstrate the **unsuitability of the classical statistical models for
  conversational documents** and propose a novel approach which is able to achieve a **high
  accuracy rate (up to 95%) for hundreds of authors**."
- This is a crucial, citable negative result: **the classical models do not transfer to chat** —
  a different document model is required.

### 4.2 Segalin, Perina, Cristani & Vinciarelli 2012 — conversation-analytic features `[OPENED via PDF]`
**"Conversationally-inspired stylometric features for authorship attribution in instant messaging",
ACM Multimedia 2012, pp. 1121–1124.** DOI 10.1145/2393347.2396398.
PDF: https://www.cristinasegalin.com/research/papers/ACMM12.pdf
- **Corpus: 77 individuals**, each in a **dyadic** chat conversation with an interlocutor.
- **Two innovations**: (1) features inspired by **Conversation Analysis** (turn-taking); (2) features
  extracted from **individual turns** rather than whole conversations — all prior work applied
  feature extraction to the entire conversation.
- **Privacy constraint** (relevant precedent for using a real person's messages): "Because of
  privacy and ethical issues, **features that do not involve the content of the conversation** can
  be used, namely number of words, characters, punctuation marks and emoticons." → a **content-free
  baseline** is possible.
- **Conversational features**: turn duration; **number of "return" characters** (an indirect
  measure of dominance / tendency to hold the floor); **characters per second** and **words per
  second** (typing rate, cognitive load); **mimicry** = ratio of words in the current turn to the
  previous turn ("the tendency of a subject to follow the conversation style of the interlocutor").
- Statistics: exponential histograms (bin sizes grow with feature value) "because the turns are
  short and small values tend to be more represented" — chosen over linear histograms and shown to
  improve performance.
- Feature selection: **50 runs of forward feature selection**, then the **Kuncheva stability index**
  to distil a single subset → **12 features**.
- **Results**:
  - **nAUC = 89.5%** (area under the Cumulative Match Characteristic curve) with the full method.
  - **Rank-1 accuracy 29.2%** with the selected 12-feature pool.
  - Conversational features increase matching probability by **~10% in the first 10 ranks**.
  - **Conversational features alone beat standard stylometric features** computed over the whole
    set of turns.
  - **Turn-count saturation**: "**Increasing the number of turns increases the nAUC score, even if
    the increase appears to be smaller around 30 turns.**" → this is the closest thing in the
    literature to a **"≈30 turns / ≈30 messages are enough"** threshold, and it is the honest
    citation for a "~30–50 message" heuristic rather than a 50-message rule invented ad hoc.

### 4.3 Küçükyılmaz, Cambazoğlu, Cevdet et al. 2016 — multiparty chat in Turkish `[SNIPPET]`
**"Authorship recognition in a multiparty chat scenario", IEEE IWBF 2016.**
DOI 10.1109/iwbf.2016.7449681
- **Large corpus of multiparty chat records in Turkish from a multiplayer game database**; the
  **most active 978 users** selected by participation in game chat sessions.
- Features: **character matrices** per player; methods: **re-centered local profiles** +
  **cosine similarity**. Systematically assesses the effect of **text normalization**.
- **Best result: ~75% rank-1 accuracy for a gallery size of 978.**
- Relevant because it is **multiparty** (many-to-many), which is the realistic chat condition, and
  because it shows **normalization choices materially change accuracy**.

### 4.4 Hinglish WhatsApp — the closest published analogue to a code-mixed chat corpus `[OPENED via PDF]`
**Abhay Sharma, Ananya Nandan & Reetika Ralhan, "An Investigation of Supervised Learning Methods
for Authorship Attribution in Short Hinglish Texts using Char & Word N-grams", ACM TALLIP
(accepted Dec 2018); arXiv:1812.10281.**
URL: https://arxiv.org/pdf/1812.10281
- **Corpus: WhatsApp**, personal **and group** texts from **four authors**, **~76,000 words**
  (approximately uniformly distributed). All participants share a dialect; the conversation is
  **Hindi–English code-mixed**, with Hindi written in **Latin script** rather than Devanagari.
- This is a direct precedent for the survey's corpus type: **informal, code-mixed, Latin-script
  romanisation, WhatsApp/WeChat-like.**
- Features: word unigrams and bigrams; character 3-, 4-, 5-grams. Classifiers: Naïve Bayes, SVM,
  Conditional Tree, Random Forest. Weighting: TF, TF-IDF, Binary.
- **Results**: **SVM 95.079%** test accuracy (char 3-gram), **94.862%** (word unigram); **Naïve
  Bayes 94.455%** (word unigram), 93.259% (char 3-gram). Conditional Tree and Random Forest
  underperformed.
- **Best features: word unigram and character 3-gram**; performance degrades at higher n.
  "**Word bigrams led to surprisingly large performance reductions with accuracy decreasing up to
  60%**... the texts are too short for regular re-occurrence of bigrams."
- **Binary weighting generally best**, then TF, then TF-IDF.
- **Caveat the survey must state: n = 4 authors.** 95% here is not comparable to the 30.3% for
  1,000 authors in Schwartz et al.

### 4.5 SMS `[OPENED via CERIAS report]`
**Ashwin Mohan, Ibrahim M. Baggili & Marcus K. Rogers, "Authorship attribution of SMS messages
using an N-grams approach", CERIAS Tech Report 2010-11, Purdue University.**
URLs: https://www.cerias.purdue.edu/assets/pdf/bibtex_archive/2010-11-report.pdf ·
https://www.cerias.purdue.edu/assets/pdf/bibtex_archive/2010-11.pdf
- **28 users**; gram sizes **1–5**; seven similarity-scoring algorithms (Cosine, Jaccard, Dice,
  Block distance, Euclidean, Overlay coefficient, Matching coefficient).
- **Accuracy 65–72%.** Best gram size **3 for smaller message sets, 5 for larger**; Euclidean and
  Block distance best for larger sets, block distance for smaller.
- **Tokenization choice that matters for chat**: "In most systems using N-grams (documents, e-mail)
  capitalization and word spaces are removed. With SMS, the authors make the assumption that this
  is **not feasible since the data available is limited in a single SMS message and these could be
  stylistic features that are unique to an author**." They keep capitalization, word spaces,
  **punctuation (colon, semicolon, ellipsis)** and whole/floating-point numbers as stylistic markers.
- Motivation includes two real cases: the **Danielle Jones** case (2001; linguistic analysis
  concluded the messages were more likely written by her uncle) and the **Jenny Nicholl** case
  (messages most likely written by her ex-lover). These give the survey a forensic anchor for
  "whose style does this text carry".

### 4.6 Chinese-language work
- **"Applying clustering algorithms to determine authorship of Chinese Twitter messages", Proc.
  IEEE URTC 2016.** DOI 10.1109/urtc.2016.8361150 `[SNIPPET]`
  - Dataset: **10 authors × 100 tweets each** from publicly available Chinese Twitter profiles.
  - Algorithms: simple **k-means (SKM)** and **Expectation Maximization (EM)** in WEKA.
  - Features: **character n-grams and Chinese function words** derived from the literature.
  - **Accuracy: up to 44.53% (3 authors), 29.24% (5 authors), 20.52% (10 authors).** SKM better
    than EM for these sets.
  - Finding: "**function words are valuable features in attributing Chinese Tweets**", and they
    identify which Chinese function words mattered most. (Builds on **Bei Yu, "Function Words for
    Chinese Authorship Attribution", 2012**.) → **Chinese function words are an established feature
    family**, relevant to a Chinese/English code-mixed clone.
- **Z. T. Liu, "A Study on Authorship Attribution for Chinese Instant Messages Based on Dependency
  Grammar", Master's thesis, China, posted 2021-04-14 (Foreign Linguistics and Applied
  Linguistics).** Aggregator record: https://globethesis.com/?t=2415330626459513 `[SNIPPET, weak
  source]`
  - **Manually annotated WeChat messages** naturally produced by both **sociolinguistically
    similar and sociolinguistically diverse** authors.
  - Features: **mean dependency distance, mean hierarchical distance, and relative frequencies of
    each dependency-relation type**.
  - Findings: the features have statistically significant discriminating power; they contribute
    differently to the similar vs. diverse tasks; "the features give **satisfactory performance in a
    case involving up to five sociolinguistically similar authors**"; a **larger feature set and
    fewer authors** yield better results; the authors hypothesise a mechanism of **syntactic
    alignment**.
  - Caveat: this is a thesis-aggregator record, **not a peer-reviewed venue**; treat quantitative
    claims as indicative. The claim "up to five similar authors" is the only concrete number.
- **A. Q. Cheng, "Research on Authorship Analysis for Chinese Weibo Text", Master's thesis,
  2020-05-04.** https://globethesis.com/?t=2415330590480473 `[SNIPPET, weak source]`
  - Proposed a comparative authorship-analysis procedure with four steps: (1) define a fixed
    feature set; (2) test **within-author consistency** and **across-author distinctiveness** on
    known texts; (3) test the queried texts; (4) draw conclusions.
  - **Five authors**; "the 'queried texts' have been successfully assigned to the right authors in
    two analyses".
  - The four-step consistency/distinctiveness protocol is worth citing as a **methodological
    template** — it is exactly the right structure for validating a persona clone's fidelity.
- **Weibo per-post human ceiling** `[OPENED via PDF]` — "Gender Prediction for Chinese Social
  Media Data", **RANLP 2017**, https://acl-bg.org/proceedings/2017/RANLP%202017/pdf/RANLP058.pdf.
  Although the task is gender, the human-vs-machine comparison is directly transferable:
  per-post automatic accuracy **no higher than 63.2%** (cleaned data 62.8%), rising to
  **~70%** for high-confidence cases or posts of **16–40 words**. Four human annotators on 200
  random posts scored **64.0%** and **59.5%** (Weibo users) and **58.5%** and **55.5%**
  (non-users), while the machine scored **64.5%** on the same 200 posts.
  → **on a single short Chinese social-media post, humans are at chance-level-plus-10 and
  machines are indistinguishable from humans.** Character vs. word n-grams performed equally
  (both 62.8%), with unigrams individually better than bigrams/trigrams (sparsity).

### 4.7 Note on the specific "~50-message / ~500-token" thresholds
**Honest status.** I could **not** find a primary source that states "50 messages" or "500 tokens"
as a general authorship-attribution threshold. What exists instead:
- **~30 turns / messages**: Segalin et al. 2012 report the nAUC gain becomes smaller "around
  **30 turns**" (§4.2). `[OPENED]`
- **~120 tweets/user**: Layton et al. 2010's explicit "important threshold". `[SNIPPET]`
- **50 training tweets**: the smallest training size in Schwartz et al.'s sweep, producing
  **50.7%** at 50 authors and **30.3%** at 1,000 authors. `[SNIPPET]`
- **50 SMS**: the sweep point at which accuracy "goes below 48%" (with 20 test SMS), vs ~88% at
  >500 training SMS. `[SNIPPET]`
- **500 words**: Koppel & Winter's document unit for the whole 500-pair experiment; also the
  minimum chunk size for classical unmasking (Koppel et al. 2007; Generalizing Unmasking 2019).
- **500 words** is also the **explicit exclusion floor** in Brennan et al. 2012 ("no samples
  less than 500 words"), i.e. the *smallest unit they considered usable as a writing sample*.
→ **A "~50-message / ~500-token" figure should be presented in the survey as a synthesis, not as
a quoted threshold**, unless a direct source is found. See `UNVERIFIED` list.

---

## 5. "It's really about function words" — the evidence, with numbers

### 5.1 Koppel, Schler & Argamon 2009 — the survey `[OPENED]`
**"Computational Methods in Authorship Attribution", JASIST 60(1):9–26 (2009).**
DOI 10.1002/asi.20961. Preprint opened:
https://u.cs.biu.ac.il/~koppel/papers/authorship-JASIST-final.pdf
- **The origin**: "Mosteller and Wallace (1964)... considered distributions of **function words**.
  The reason for using function words in preference to others is that **we do not expect their
  frequencies to vary greatly with the topic of the text**, and hence we may hope to recognize
  texts by the same author on different topics. It is also **unlikely that the frequency of
  function word use can be consciously controlled**, so one may hope that use of function words
  for attribution will **minimize the risk of being deceived**."
- **Set size**: "Typical modern studies using function words in English use lists of **a few
  hundred words**, including **pronouns, prepositions, auxiliary and modal verbs, conjunctions,
  and determiners**."
- Famous negative result on the *unitary invariant* approach: single-marker methods "for the most
  part **ha[s] not proved stable** (Sichel 1986; Burrows 1992; Grieve 2007)".
- **Their own three testbeds**:
  1. **Emails between the two authors (Koppel and Schler), 2005**: **246 emails from Koppel and
     242 from Schler**, headers/greetings/signatures/quotes stripped. "**Some of the texts were as
     short as a single word.**" Train = messages before July 1; test = second half.
  2. **Two books each by nine late-19th/early-20th-century authors** (Hawthorne, Melville, Cooper,
     Shaw, Wilde, C. Brontë, A. Brontë, Thoreau, Emerson). One for training, one for testing;
     **each 500-word chunk in the test books was tested separately**.
  3. **Twenty prolific bloggers** harvested August 2004; posts per blogger **217 to 745**, average
     **just over 250 words per post**; last **30 posts** of each blogger = test corpus.
- **Feature families compared**: function words (FW); parts of speech (POS); **systemic functional
  linguistics (SFL) word classes**; content words (the **1,000 highest-infogain features among the
  10,000 most frequent**); **character trigrams** (same selection rule).
- **Findings, quoted**: "**Naïve Bayes... performs very poorly for all feature sets.** Moreover,
  **SVM and Bayesian regression are far superior** to the other learning algorithms, for all feature
  sets. Moreover, for these learners, **SFL features are approximately as good as function words
  and parts of speech together.**"
- **On topic/content words — the "does adding topic words help or hurt" answer**: "In the corpora
  we consider here, **content words prove to be very useful; in no case do they lead us astray.**
  Especially surprising is the effectiveness of the character n-gram feature set. Note that
  **character n-grams perform almost identically to content words for the first two corpora and
  significantly outperform content words for the blog corpus.**" Character n-grams are interpreted
  as "proxies for content words (e.g., `dsh` for `spreadsheet`), as well as for **function words,
  parts-of-speech and even formatting** (e.g., the string **colon—newline—1** suggests a numbered
  list)." For blogs they also capture acronyms and abbreviations.
- **Their practical recommendation, verbatim**: "when the context indicates that **purely stylistic
  features are appropriate**, the combination of **parts-of-speech and function words** constitutes
  a reasonable choice of feature set and **SFL features can be used as an efficient proxy for this
  combination**. When **content features are appropriate**, properly chosen **unigrams** are a good
  choice, with similarly chosen **character tri-grams** an efficient and **language-independent
  proxy**."
  → The honest modern reading is **not** "function words dominate"; it is **"POS + function words
  when topic is controlled, character trigrams as the language-independent workhorse, and content
  words do not hurt."** The paper's own data contradicts the strong "it's all function words" claim.
- **Needle-in-a-haystack experiment (the most useful numbers for short-text work)**:
  - Corpus: the **20,000 longest blogs**; **10,000 for test snippets** (each "enough of the most
    recent posts to total **at least 500 words**"), the other **10,000 held out for meta-learning**.
    Task = assign each snippet to one of **10,000** blogs, **independently per snippet** (the
    one-to-one correspondence is deliberately not exploited).
  - Plain tf-idf + cosine: **content representations assign the snippet to the actual author
    between 52% and 56% of the time**, while the **style representation lags behind with only 6%**.
    **64%** of snippets are most similar to their actual author's known work in **at least one** of
    the four representations.
  - With meta-learning (linear SVM on the holdout set, deciding whether a pair is reliable):
    "we can achieve recall of **40% with precision of 87%**, but if we can settle for recall of
    **30%, we can get precision of 94%**."
  - **Snippet length sensitivity**: with snippets limited to **200 words**, "at a recall level of
    **30% we achieve precision of 86%** and at recall of **40% we get precision of 73%**."
  - **Unattributable texts** (5,000 known works removed from the candidate set, so half the test
    cases have no correct answer available): "at a recall level of **30% we achieve precision of
    81%**."
  → This is the single best quantitative benchmark for "how much text does a needle-in-a-haystack
  open-set attribution need": **500 words → 87%/40% precision/recall; 200 words → 86%/30%.**
- **Caveat noted in the 2009→2014 line of work**: Koppel et al. 2011's feature-subsampling method
  is the machinery behind both this and the 2014 impostors paper.

### 5.2 Kestemont 2014 — "Function words in authorship attribution: from black magic to theory?"
**Mike Kestemont, Proc. 3rd Workshop on Computational Linguistics for Literature (CLFL) 2014,
pp. 59–66, ACL.** `[SNIPPET]` — cited (with the "Koppel-512" function-word list attribution) in
arXiv:2208.07395, which states: "The '**Koppel-512**' function word list contains **512 function
words** adopted from the widely-cited authorship attribution experiment described in Koppel et al.
(2009). Function words are typically free of obvious meaning (e.g., 'the', 'and', 'or', 'this') and
have been used extensively in authorship attribution research (Kestemont, 2014)." I did **not**
open Kestemont's paper, so the 512-item list size is `[SNIPPET]`-verified via the replication paper
and the ACL Anthology record is at https://aclanthology.org/W14-0908/ `[UNVERIFIED venue id]`.

### 5.3 "Topic words help or hurt" — the direct evidence
- **Koppel et al. 2009**: content words "in no case... lead us astray"; character trigrams (which
  proxy content) beat pure content words on blogs. `[OPENED]`
- **Luyckx & Daelemans 2011**: "the results presented here indicate a role for topic" — topic
  affects attribution performance. `[SNIPPET]`
- **PAN 2015** (the design-level finding): the whole task became much harder once documents within
  a problem no longer matched topic and genre — "low-frequency stylistic features are heavily
  affected by topic nuances". The Dutch (cross-genre) part was the hardest. `[OPENED]`
- **PAN 2018 cross-domain**: "features such as function words or common character-level n-grams
  are typically considered valuable characteristics, **because they are less strongly tied to the
  specific content or genre of texts. Such features nevertheless require relatively long documents
  to be successful and they typically result in sparse, less useful representations for short
  documents.**" `[OPENED]` → **the key tension for a 104k-message corpus: style features are
  topic-robust but length-hungry.**
- **Sapkota et al. 2015** (reported in the PAN 2015 overview): in cross-topic/cross-genre
  attribution on newspaper opinion articles and book reviews, "**character n-gram features are
  more robust with respect to word features**"; and character n-grams "corresponding to **word
  affixes, including punctuation marks**, are the most significant features". Also: "using training
  texts from **multiple topics** instead of a single topic can significantly help to correctly
  recognize the author of texts on another topic." `[SNIPPET — via PAN 2015 overview]`
- **Mosteller & Wallace 1964** is the foundational result: Bayesian classification over "a set of a
  few dozen function words" for the *Federalist* papers.
- **Bagnall 2015's ablation** (§1.5) is the counterweight: character unigram frequencies alone
  reached **AUC 0.85 (EN) / 0.91 (ES)** on PAN 2015 training — i.e. "mere character frequency"
  is a strong baseline, and much of the "function word" signal is recoverable from raw characters.

---

## 6. Unmasking — the closest classical analogue to "does this feel like the same person"

**Koppel, Schler & Bonchek-Dokow, "Measuring Differentiability: Unmasking Pseudonymous Authors",
Journal of Machine Learning Research 8 (2007) 1261–1276.** `[OPENED]`
URLs: https://jmlr.org/papers/volume8/koppel07a/koppel07a.pdf · https://jmlr.org/papers/v8/koppel07a.html
(Introduced originally in **Koppel & Schler, ICML 2004**, `[SNIPPET]`.)

### What it measures
Not "are these similar" but "**how deep is the difference**". Verbatim hypothesis:
> "Our main hypothesis is that **if A and X are by the same author, then whatever differences there
> are between them will be reflected in only a relatively small number of features**, despite
> possible differences in theme, genre and the like."

### Why the naive methods fail (this is the conceptual core)
- **Approach 1 — "lining up impostors"** (learn A vs. not-A on an external corpus, chunk X, vote):
  conceptually flawed, because "any author who is neither A nor represented in the sample not-A,
  but who happens to have a style more similar to A than to not-A, will be falsely determined by
  this method to be A."
- **Approach 2 — one-class SVM**: "conceptually sound but we will see that it performs poorly in
  practice."
- **Approach 3 — compare A directly to X by cross-validation accuracy**: "**This method does not
  work well at all.**" The worked counterexample: distinguishing *The House of the Seven Gables*
  from Melville, Cooper **and** Hawthorne all yield cross-validation accuracy **above 98%** — yet
  Hawthorne wrote it. "If we were to conclude, therefore, that none of these authors wrote Gables,
  we would be wrong."
  → **This is the most important single citation for anyone building a "does the clone match this
  person" detector: raw discriminability between a person's texts and their own other texts is
  ~98%, so a high classifier score proves nothing.**

### The mechanism
```
1. Initial feature set = the n words with highest average frequency in A∪X
   (average of the frequency in A and in X, equal weight).
2. Linear-kernel SVM, ten-fold cross-validation accuracy of A vs. X
   (surplus chunks in the larger set randomly discarded; accuracy averaged over 5 runs).
3. From each fold's model, eliminate the k most strongly weighted positive features
   and the k most strongly weighted negative features.
4. Repeat from step 2.
```
- **Canonical settings: n = 250, k = 3, m ≈ 8 iterations.** Chunking: "approximately equal sections
  of **at least 500 words** without breaking up paragraphs."
- Curve-shape intuition: for different authors, accuracy degrades **slowly and smoothly**; for the
  same author it degrades **suddenly and dramatically**. Worked example: *Gables* vs. Hawthorne's
  *The Scarlet Letter* — the distinguishing features were essentially **`he`** (more frequent in
  *Scarlet Letter*) and **`she`** (more frequent in *Gables*). "The situation in which an author
  will use a small number of features in a consistently different way between works is typical."
- **Curve → decision, via meta-learning**: each curve is represented as a vector of
  **accuracy after round i**, **accuracy difference between rounds i and i+1**, **difference between
  i and i+2**, **i-th highest accuracy drop in one iteration**, and **i-th highest accuracy drop in
  two iterations**, for i = 0…m. A linear SVM then classifies curves as same-/different-author.

### Numbers
- **Corpus**: **21 nineteenth-century English books by 10 authors**, spanning genres; all
  electronically available books by those authors that were **above 500K** and had no special
  formatting. **209 independent verification experiments** = 21 books × 10 authors, minus the pair
  Emily Brontë / *Wuthering Heights*.
- **One-class SVM baseline** (250 most frequent words of A, RBF kernel, majority of X's chunks):
  of the **20 pairs that should be same-author, only 6 were correctly classified** (30%);
  of the **189 different-author pairs, 46 were incorrectly classified** (75.7% correct).
  Other kernels and other thresholds only degrade results.
- **Unmasking, leave-one-book-out**: "**All but one of the twenty same-author pairs are correctly
  classified**" (the exception is *Pygmalion* by Shaw). "**181 of 189 different-author pairs were
  correctly classified**" (notable errors: attributions of *The Professor* by Charlotte Brontë to
  each of her sisters). "**Thus, we obtain overall accuracy of 95.7% with errors almost identically
  distributed between false positives and false negatives.**"
- The authors note that some of the 8 misclassified different-author pairs imply a single book
  attributed to two authors, which is impossible — 8 is therefore an upper bound on genuine errors.
- **Robustness claims**: "Nothing in our method is tied to any particular language, period or
  genre"; "some evidence presented suggests that the method is immune to deliberate attempts to
  cover up authorship."
- **Value of negative data**: "Even when we completely ignore negative examples and thus treat
  authorship verification as a **true one-class classification problem**, our methods obtain
  extremely high accuracy on out-of-sample author/book pairs. When we use **just a bit of
  non-representative negative data, classification is even better.**"

### The short-text obituary for classical unmasking
- **Sanderson & Guenter 2006** `[SNIPPET]`: unmasking is "less useful when dealing with relatively
  short texts"; at ~5,000 words "the unmasking effect [is] considerably less pronounced... and
  different-author unmasking curves [have] close similarities to the same-author curves."
- **Koppel & Winter 2014** `[OPENED]`: "empirical studies (Sanderson & Guenter, 2006) have shown
  that unmasking is **ineffective for short input documents (less than 10,000 words)**"; and
  unmasking "requires that the input documents be very long" because "chunks of text must be
  reasonably long (**at least a few hundred words**) to gain any kind of statistical
  representativeness."
- **Bevendorff, Stein, Hagen & Potthast 2019, "Generalizing Unmasking for Short Texts", NAACL-HLT
  2019, pp. 654–659. ACL Anthology: https://aclanthology.org/N19-1068/** (PDF
  https://aclanthology.org/N19-1068.pdf; authors verified at https://aclanthology.org/N19-1068/)
  `[OPENED via PDF]`
  - The problem statement: "unmasking is one of the most robust approaches as of today with the
    major shortcoming of **only being applicable to book-length texts**" — because it needs "many
    chunks per text, where each chunk has to be of at least the aforementioned **500 words**
    length, or else the training data becomes too sparse and no descriptive curves can be
    generated."
  - **Their generalized algorithm**: 30 chunks of **700 words** each by **random chunk generation**;
    the **250 words with highest average frequency** in A and B as features; 10-fold CV linear SVM;
    eliminate on average the **5 most significant positive and negative features across folds**
    (total **10 removals per round**); meta-classifier trained on the curves, their
    **central-difference gradients (first- and second-order)**, and their **gradients sorted by
    magnitude**. Multiple runs averaged to smooth the curves.
  - **Claim**: verification "of texts as short as **four printed pages** with very high precision at
    an adjustable recall tradeoff"; accuracies **75–80%**, on par with other state-of-the-art
    techniques optimised for that length. "reduces the required material by **orders of magnitude**."
  - **Confidence threshold c (distance from the SVM hyperplane)**: at c = **0.8**, an answer is
    derived for only **13.8%** of cases but with **precision 1.0** ("all same-author classifications
    are correct"); at c = **0.4**, about **half** the cases can be classified with a still
    all-correct answer set. Recommend **c ≥ 0.6** for medium-to-high assurance and **c ≥ 0.7** if
    false positives must be entirely avoided.
  - **Hyper-parameter envelope**: 25–100 chunks; vector sizes **250–400** features; **not fewer
    than 5 and no more than 20 removals per round**; chunk sizes **300–1,000 words** with
    **500–700** best; about **10 total runs averaged**, 15–20 "still a sensible choice".
  - They quote the PAN 2015 winner as a calibration point: "**Bagnall (2015) achieved an accuracy
    of 76%, thus delivering a false decision in one in four cases**."
  - They also cite the origin of the 5,000-word rule: "Sanderson and Guenter (2006) showed that its
    performance is far worse for short texts, though, whereas **their own model produced acceptable
    results with a minimum of 5,000 words per training text**."

---

## 7. Style change, intrinsic plagiarism, author diarization — "this person's style varies per recipient"

Summary of what the field has established:
1. **Detecting *that* a document has multiple authors is now tractable**: PAN 2018's binary style
   change detection reached **~90% accuracy** (Zlatkova et al.) and **all** submitted approaches
   beat **all** baselines (§1.8). But that is on StackExchange Q&A answers, which are long and
   topically homogeneous by construction.
2. **Locating *where* the style changes is not**: PAN 2017's best WinF was **0.3226** with
   WindowDiff **0.5456** over only 3 submissions (§1.7).
3. **Clustering documents by author, when the number of authors is unknown, is weakly solved**:
   PAN 2016 best BCubed F **0.8223** vs a **random baseline of 0.6666**, with **MAP 0.1689** for
   authorship-link ranking (§1.6).
4. **Attributing segments within a document (diarization) is essentially open**: PAN 2016 best
   BCubed F **0.52** (known *n*) / **0.48** (unknown *n*) from **2 teams**; intrinsic plagiarism
   macro-F **0.22** best and **0.14** for the runner-up (§1.6).
5. **The style-relevant variable is segment length, not recipient**: PAN 2017 found the winning
   system's performance "**decreases drastically for segment lengths of over 500 words**" and is
   highest for **very short segments**; and performance varies with document length, peaking for
   **1,000–2,000-word** documents. `[OPENED]`
6. **Genre is the dominant confound**: PAN 2015's cross-genre Dutch part was the hardest of the
   four languages for almost everyone, and the top cross-topic system (Bagnall) collapsed there
   (score **0.45**, rank 7). Koppel & Winter list "if documents X and Y are in different genres, it
   is much more difficult to distinguish same-author/different-author pairs" as their first
   limitation. `[OPENED]`
7. **Intrinsic plagiarism detection definition** (for the survey's framing): PAN 2016 formalized it
   as one main author writing **≥70%** of the text with up to **30%** intrusive, **exactly two
   clusters**; evaluation by micro- and macro-averaged F-score; diarization by **BCubed**.
   The heritage is Meyer zu Eissen, Stein & Kulig 2007, "Intrinsic Plagiarism Detection" (cited in
   Koppel & Winter 2014 as "similar, though not identical, to the authorship verification problem").
8. **Author clustering problem statement** (worth quoting for "one person, many registers"):
   PAN 2016 assumes collections are of **up to 100 documents**, **all single-authored**, **same
   language**, **same genre**, **topic may vary**, **length may vary**, and the **number of distinct
   authors is not given**.

---

## 8. What this evidence base says about the persona-clone / 104k-message case

Framed strictly as what the cited numbers license, not as advice:

1. **Total volume is not the constraint.** 104k messages is far beyond every volume threshold in
   the literature: the classical minimum is 5,000–10,000 words per author (Sanderson & Guenter;
   Burrows 2007; Eder 2015), and the "6,500 words" figure is a 2000-era *adversary* bound
   (Rao & Rohatgi) re-used as a collection rule by Brennan et al. 2012.
2. **The unit of evidence is the constraint.** A single short message carries almost no signal:
   the human ceiling measured on single Chinese social-media posts is 55.5–64.0% against a machine
   at 64.5% (RANLP 2017); single-tweet attribution at 1,000 authors is 30.3–36.5% (Schwartz et al.
   2013; Shrestha et al. 2017). Conversely, **many short messages are known to substitute for long
   text** — Stamatatos 2007 (via Luyckx & Daelemans 2011): "the best method uses **many short text
   samples** for minority classes and **less but longer ones** for the majority classes"; and the
   Enron AV corpus explicitly **aggregates short mails per author** to reach 3–4 KB documents.
3. **Abstention is the methodologically honest output.** Both the impostors method and generalized
   unmasking are evaluated as precision at a recall operating point (87% precision at 40% recall;
   precision 1.0 on 13.8% of cases). The PAN tasks introduced c@1 precisely to reward abstention.
   A clone-verification instrument should not report a scalar "authenticity %" without a threshold
   and an abstain region.
4. **Raw discriminability proves nothing.** *Gables* is >98% distinguishable from each of three
   candidate authors including its true one (Koppel et al. 2007). Coherence must be measured as
   **how fast the difference collapses when the distinguishing features are removed**, not as how
   well a classifier separates.
5. **Character n-grams, not function-word lists, are the workhorse** — especially for a
   **Chinese/English code-mixed** corpus, where a fixed English function-word list cannot span both
   languages. Chinese function words are separately established as valuable (Bei Yu 2012; URTC
   2016), and character n-grams are explicitly "language-independent" (Koppel et al. 2009;
   Koppel & Winter 2014; PAN 2018's winner is an ensemble of simple char/word n-gram methods).
6. **Code-mixed informal chat is under-covered.** The nearest published analogue is the 4-author
   Hinglish WhatsApp study (95.08%, char 3-gram; word bigrams collapse by up to 60% because texts
   are too short) — a **4-author** result that must not be compared to 1,000-author results.
   The Chinese chat literature is thin: a WeChat dependency-grammar master's thesis ("satisfactory
   performance... up to five sociolinguistically similar authors") and a Chinese-Twitter clustering
   paper (20.52% at 10 authors) are the only WeChat/Chinese-chat items found.
7. **Message-level metadata carries real signal.** WhatsApp/SMS work keeps capitalization, spacing,
   punctuation and numbers as features (Mohan et al. 2010), and chat work finds **turn-taking,
   typing rate, "return" characters and mimicry** among the most informative features (Segalin
   et al. 2012). These are the features a message-level clone check would use instead of content.

---

## 9. Explicitly UNVERIFIED / not found

| item | status |
|---|---|
| **Rao & Rohatgi 2000 (USENIX Security), "Can pseudonymity really guarantee privacy?"** | Primary PDF **not opened**. The 6,500-word figure and the 19,415-articles/117-authors corpus are quoted from two independent secondary sources (Humanities Data Analysis notebook; arXiv:2208.07395). Cite as secondary or verify the primary. |
| **Koppel & Schler 2004, ICML** | Not opened; characterised only via Koppel et al. 2007 and Bevendorff et al. 2019. |
| **Kestemont 2014, "Function words in authorship attribution: from black magic to theory?"** | Not opened. The **512-item "Koppel-512" list size** is quoted from arXiv:2208.07395, not from Kestemont. |
| **A general "~50 messages" threshold** | **Not found in any primary source.** Nearest verified anchors: **~30 turns** (Segalin et al. 2012, nAUC gain flattens), **120 tweets/user** (Layton et al. 2010), **50 training tweets** as the smallest sweep point (Schwartz et al. 2013; Shrestha et al. 2017). Do **not** present 50 as a sourced threshold. |
| **A general "~500 token" threshold** | Not found as a threshold. **500 words** appears as: Koppel & Winter's document unit; the minimum unmasking chunk size; and Brennan et al.'s explicit exclusion floor ("no samples less than 500 words"). |
| **PAN 2012 formal citation of the verification sub-results** | The PAN 2012 traditional-attribution overview was read for corpus structure only; PAN 2012 is cited as `[SNIPPET]` because the PDF was not independently opened in this session. The author is Patrick Juola. |
| **Identities of the SMS/Twitter studies summarised inside arXiv:2008.01533** | The numeric claims (53.2% at 10,000 users; 20.25% at 81 authors; ~88%/~41%/~61%/<48% SMS sweep) are quoted **as reported by** arXiv:2008.01533. The underlying reference identities/venues are `[UNVERIFIED]`. |
| **Chinese thesis records (Liu 2021; Cheng 2020)** | Sourced from a thesis aggregator, **not peer-reviewed**; no numeric accuracy figures are given beyond "up to five sociologically similar authors" and "five authors". |
| **Küçükyılmaz et al. 2016 author list** | Only partially resolved (surname plus co-authors Cambazoğlu, Can appear in the reference list of arXiv:2003.11545). Venue and DOI verified; full author list `[UNVERIFIED]`. |
| **PAN 2016 diarization per-team identities** | Winner names (Kuznetsov et al., Sittar et al.) come from the PAN'16 overview tables; individual notebook papers were not opened. |
| **The "104k WeChat messages" corpus itself** | No published authorship-attribution study on a corpus of that size or on WeChat one-to-one chats at scale was found. This is a genuine gap in the literature, not a research failure. |

---

## Sources

Every URL consulted or cited above.

**PAN overviews and task pages**
- https://ceur-ws.org/Vol-1177/CLEF2011wn-PAN-ArgamonEt2011.pdf — Argamon & Juola, PAN 2011 overview `[OPENED]`
- https://downloads.webis.de/pan/publications/papers/argamon_2011.pdf — same, webis mirror
- https://pan.webis.de/clef11/pan11-web/authorship-attribution.html — PAN 2011 task page
- https://ceur-ws.org/Vol-1177/CLEF2011wn-PAN-TanguyEt2011.pdf — Tanguy et al., PAN 2011 notebook (corpus-size corroboration)
- https://ceur-ws.org/Vol-1178/CLEF2012wn-PAN-Juola2012.pdf — Juola, PAN 2012 traditional attribution overview `[SNIPPET]`
- https://ceur-ws.org/Vol-1178/CLEF2012wn-PAN-PotthastEt2012.pdf — Potthast et al., PAN 2012 plagiarism detection overview (context)
- https://ceur-ws.org/Vol-1179/CLEF2013wn-PAN-JuolaEt2013.pdf — Juola & Stamatatos, PAN 2013 overview `[OPENED]`
- https://downloads.webis.de/pan/publications/papers/juola_2013.pdf — same, webis mirror
- https://pan.webis.de/clef13/pan13-web/authorship-verification.html — PAN 2013 task page with ranked results
- https://zenodo.org/records/3715999 — PAN13 Author Identification: Verification dataset record
- https://downloads.webis.de/pan/publications/papers/stamatatos_2014.pdf — Stamatatos et al., PAN 2014 overview `[OPENED]`
- https://pan.webis.de/clef14/pan14-web/authorship-verification.html — PAN 2014 task page with the final score table
- https://ceur-ws.org/Vol-1180/CLEF2014wn-Pan-FreryEt2014.pdf — Fréry, Largeron & Juganaru-Mathieu, PAN 2014 notebook `[OPENED]`
- https://ceur-ws.org/Vol-1180/CLEF2014wn-Pan-HalvaniEt2014.pdf — Halvani & Steinebach, VEBAV, PAN 2014 notebook `[OPENED]`
- https://downloads.webis.de/publications/papers/stamatatos_2015b.pdf — Stamatatos et al., PAN 2015 overview `[OPENED]`
- https://downloads.webis.de/pan/publications/papers/halvani_2015.pdf — Halvani et al., PAN 2015 notebook (corpus structure) `[OPENED]`
- https://downloads.webis.de/pan/publications/papers/bagnall_2015.pdf — Bagnall, PAN 2015 notebook `[OPENED]`
- https://downloads.webis.de/pan/publications/papers/pimas_2015.pdf — Pimas et al., PAN 2015 notebook (overfitting example)
- https://downloads.webis.de/pan/publications/papers/rosso_2016.pdf — Rosso et al., Overview of PAN'16 (clustering + diarization results) `[OPENED]`
- https://pan.webis.de/clef16/pan16-web/author-diarization.html — PAN 2016 author diarization task page
- https://pan.webis.de/clef16/pan16-web/author-clustering.html — PAN 2016 author clustering task page
- https://downloads-cf.webis.de/publications/slides/stamatatos_2016.pdf — Stamatatos, PAN 2016 author clustering slides
- https://downloads.webis.de/publications/papers/tschuggnall_2017.pdf — Tschuggnall et al., PAN 2017 overview `[OPENED]`
- https://downloads-cf.webis.de/publications/papers/potthast_2017g.pdf — Potthast et al., Overview of PAN'17 (187/99 documents) `[OPENED]`
- https://downloads.webis.de/pan/publications/papers/karas_2017.pdf — Karas et al., OPI-JSA PAN 2017 notebook `[OPENED]`
- https://pan.webis.de/clef17/pan17-web/style-change-detection.html — PAN 2017 style change detection task page
- https://zenodo.org/records/3737655 — PAN17 Style-Change-Detection dataset record
- https://downloads.webis.de/pan/publications/papers/kestemont_2018.pdf — Kestemont et al., PAN 2018 overview `[OPENED]`
- https://ceur-ws.org/Vol-2125/invited_paper_2.pdf — same, CEUR mirror
- https://downloads.webis.de/publications/papers/stamatatos_2018.pdf — Stamatatos et al., Overview of PAN 2018
- https://riunet.upv.es/bitstreams/87712116-50cf-4996-a2c6-293d7eba90b9/download — PAN 2018 overview with Tables 2/3/5/10 in full

**Verification, unmasking, impostors**
- https://jmlr.org/papers/volume8/koppel07a/koppel07a.pdf — Koppel, Schler & Bonchek-Dokow, unmasking, JMLR 2007 `[OPENED]`
- https://jmlr.org/papers/v8/koppel07a.html — JMLR abstract page
- https://doi.org/10.1002/asi.22954 — Koppel & Winter 2014, JASIST (DOI record)
- https://u.cs.biu.ac.il/~koppel/papers/impostors-journal-revised2-140213.pdf — Koppel & Winter preprint, full numbers `[OPENED]`
- https://slideblast.com/determining-if-two-documents-are-written-by-the-semantic-scholar_5953b45c1723dd7c1759da44.html — mirrored copy with Tables 1–3 and Fig. 4–6 numbers
- https://www.cs.cornell.edu/courses/cs6740/2016sp/classes/Determining%20If%20Two%20Documents%20Are%20by%20the%20Same.pdf — Cornell CS6740 lecture slides on the impostors method (Apuleius case study)
- https://u.cs.biu.ac.il/~koppel/papers/authorship-JASIST-final.pdf — Koppel, Schler & Argamon 2009, JASIST preprint `[OPENED]`
- https://onlinelibrary.wiley.com/doi/10.1002/asi.20961 — JASIST record
- https://arxiv.org/pdf/1706.00516 — Halvani, Winter & Graner, compression-based AV `[OPENED]`
- https://doi.org/10.1145/3098954.3104050 — ARES 2017 published version, "On the Usefulness of Compression Models for Authorship Verification"
- https://doi.org/10.17632/n77w7mygwg.1 — Halvani, Enron Authorship Verification Corpus
- https://aclanthology.org/N19-1068/ — Bevendorff, Stein, Hagen & Potthast, "Generalizing Unmasking for Short Texts", NAACL 2019 (author list verified)
- https://aclanthology.org/N19-1068.pdf — same, full text `[OPENED]`
- https://downloads-cf.webis.de/publications/papers/bevendorff_2019a.pdf — same, webis mirror
- https://aclanthology.org/W06-1657.pdf — Sanderson & Guenter, EMNLP 2006, short-text attribution + unmasking `[SNIPPET]`
- https://doi.org/10.3115/1610075.1610142 — same, DOI record

**Short-text / length thresholds**
- https://dh2010.cch.kcl.ac.uk/academic-programme/abstracts/papers/pdf/ab-744.pdf — Eder, "Does Size Matter?" `[SNIPPET]`
- https://www.clips.uantwerpen.be/~walter/papers/2011/ld11.pdf — Luyckx & Daelemans 2011, LLC `[SNIPPET]`
- https://www.humanitiesdataanalysis.org/stylometry/notebook.html — Humanities Data Analysis, stylometry chapter (source of the Rao & Rohatgi 6,500-word attribution)
- https://doi.org/10.48550/arxiv.2208.07395 — "Reproduction and Replication of an Adversarial Stylometry Experiment" (Brennan et al. 2012 instructions; Koppel-512 list) `[OPENED via arXiv HTML]`
- https://www.replicationresearch.org/articles/9414/ — same, journal HTML
- https://methods.clsinfra.io/corpus-author.html — CLS Infra survey, corpus building for authorship attribution (Eder 2013a / Eder 2017 thresholds)

**Twitter / microblog / SMS / chat**
- https://doi.org/10.1109/ctc.2010.17 — Layton, Watters & Dazeley 2010, "Authorship Attribution for Twitter in 140 Characters or Less" `[SNIPPET]`
- https://aclanthology.org/D13-1193.pdf — Schwartz, Tsur, Rappoport & Koppel 2013, "Authorship Attribution of Micro-Messages" `[OPENED via PDF]`
- https://doi.org/10.18653/v1/d13-1193 — same, DOI record
- https://aclanthology.org/E17-2106/ — Shrestha, Sierra, González, Montes-y-Gómez, Rosso & Solorio 2017, EACL (author list verified)
- https://aclanthology.org/E17-2106.pdf — same, full text `[OPENED]`
- https://aclanthology.org/E17-2106.bib — same, BibTeX
- https://arxiv.org/html/2008.01533 — Alonso-Fernandez, Belvisi, Hernandez-Diaz, Muhammad & Bigun, "Writer Identification Using Microblogging Texts for Social Media Forensics" `[OPENED via HTML]`
- https://ar5iv.labs.arxiv.org/html/2008.01533 — same, ar5iv rendering
- https://arxiv.org/html/2003.11545 — Belvisi, Muhammad & Alonso-Fernandez 2020, "Forensic Authorship Analysis of Microblogging Texts" `[OPENED via HTML]`
- https://doi.org/10.1109/iwbf49977.2020.9107953 — same, IEEE IWBF 2020 record (author list verified)
- https://www.cerias.purdue.edu/assets/pdf/bibtex_archive/2010-11-report.pdf — Mohan, Baggili & Rogers 2010, SMS n-grams `[OPENED via PDF]`
- https://www.cerias.purdue.edu/assets/pdf/bibtex_archive/2010-11.pdf — same, tech-report cover
- https://doi.org/10.1109/socialcom.2013.45 — Inches, Harvey & Crestani 2013, IRC chat attribution `[SNIPPET]`
- https://www.cristinasegalin.com/research/papers/ACMM12.pdf — Segalin, Perina, Cristani & Vinciarelli 2012, instant messaging `[OPENED via PDF]`
- https://doi.org/10.1145/2393347.2396398 — same, ACM MM 2012 record
- https://doi.org/10.1109/iwbf.2016.7449681 — Küçükyılmaz et al. 2016, multiparty chat (Turkish, 978 users) `[SNIPPET]`
- https://arxiv.org/pdf/1812.10281 — Sharma, Nandan & Ralhan 2018, Hinglish WhatsApp `[OPENED via PDF]`

**Chinese-language work**
- https://doi.org/10.1109/urtc.2016.8361150 — Chinese Twitter authorship clustering `[SNIPPET]`
- https://globethesis.com/?t=2415330626459513 — Liu, Z. T., Chinese instant messages / WeChat, dependency grammar (master's thesis) `[SNIPPET, weak]`
- https://globethesis.com/?t=2415330590480473 — Cheng, A. Q., Chinese Weibo authorship analysis (master's thesis) `[SNIPPET, weak]`
- https://acl-bg.org/proceedings/2017/RANLP%202017/pdf/RANLP058.pdf — "Gender Prediction for Chinese Social Media Data", RANLP 2017 (per-post human vs. machine accuracy) `[OPENED via PDF]`
- https://doi.org/10.1109/icccbda61447.2024.10569975 — "Authenticity Classification of WeChat Group Chat Messages Based on LDA and NLP" (adjacent WeChat NLP work, not authorship)
- https://doi.org/10.25949/19439261.v1 — Chen, "Conversational structure: a socio-semiotic study of Chinese instant messaging discourse" (QQ/MSN/Aliwangwang, 82 two-party conversations; linguistic, not attribution)
