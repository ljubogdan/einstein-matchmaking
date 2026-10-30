# Traps

The dataset hides traps on purpose. These are caught by code, not by a model, and every example cites its record.

## Across the dataset (all 1047 profiles)

| Trap | Profiles | Examples |
|---|---|---|
| Unavailable (left, fully retired) | 6 | [R0068] unavailable per notes: "Left the University of Novi Sad in March 2026;" [R0068 notes]<br>[R0444] unavailable per notes: "Professor Zarić is fully retired and is not available for project coordination, student s…" [R0444 notes] |
| Consulting only (retired, emeritus) | 16 | [R0079] consulting only per notes: "Retired since 2017;" [R0079 notes]<br>[R0090] consulting only per notes: "Professor Paunović is retired and explicitly limits his external engagement to consulting;" [R0090 notes] |
| open_to contradicts notes or bio (stricter source wins) | 7 | [R0068] open_to lists joint_project, contract_research, consulting, but notes rules it out; the stricter source wins: "joint projects, contract research, consulting" [R0068 open_to]<br>[R0444] open_to lists consulting, but notes rules it out; the stricter source wins: "consulting" [R0444 open_to] |
| Notes about another person | 2 | [R0128] notes are about Vesna Mitrović, not this profile; not used as facts: "Vesna Mitrović has expressed interest in partnerships with companies at NTP Novi Sad that…" [R0128 notes]<br>[R0191] notes are about Ninkov, not this profile; not used as facts: "Ninkov is currently co-supervising two PhD students and has limited availability for new …" [R0191 notes] |
| Same name, different people (joined on ids) | 8 | [R0128] same name as R0881; joined on ids only<br>[R0191] same name as R0435; joined on ids only |
| Too little evidence (no bio or under 2 publications) | 60 | [R0015] no bio, 0 authored publications<br>[R0020] no bio, 11 authored publications |
| Profiles with Cyrillic text, transliterated before search and quote checks | 26 | [R0002], [R0025] |

## In this run

Shortlisted researchers the matchmakers skipped (1):

- [R0276] on [C119-CH1]: no fit: The researcher's expertise in metal additive manufacturing topology optimization and support structure design does not address the core challenge of automating artwork-to-dieline placement in packaging production [R0276, SYN-PUB-03462, SYN-PUB-03464].

Shortlisted researchers with trap flags (2):

- [R0976] on [C036-CH2]: same_name
- [R0090] on [C143-CH2]: consulting_only

Times the Critic stopped a claim (121, rewrites included; stopped claims go back to their author once), by check:

- quote: 48 (e.g. profile:C017-CH3__R0013/1: quote not found in R0013.keywords; profile:C017-CH3__R0013/1: quote not found in R0013.keywords)
- policy: 4 (e.g. C075-CH3__R1023/terms/contributions: ranks or praises a person; C126-CH1__R0965/terms/contributions: ranks or praises a person)
- numbers: 8 (e.g. C115-CH1__R0856/companyBrings/1: 2.3 is not in any cited field; C138-CH1__R0753/problem/3: 15,000 is not in any cited field)
- support: 61 (e.g. C017-CH3__R0013/universityBrings/1: Field states regression equations were developed for chernozem texture classes to predict lime requirements in specific municipalities, not that methods have been 'compared and calibrated locally' as an ongoing process or applied to all northern Vojvodina.; C017-CH3__R0013/whyThisPair/2: Field does not state that the researcher's study was limited to chernozem samples or that this contrasts with the company's soil types; it only states 48 chernozem samples were used but does not compare this to company's parcel conditions.)
