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

Shortlisted researchers the matchmakers skipped (2):

- [R0564] on [C001-CH1]: no fit: The researcher's publications focus on active network reconnaissance, attack-surface modelling, scanning strategies, and topology discovery—all offensive or IT-oriented security techniques. The challenge requires unsupervised anomaly detection on Modbus and BACnet traffic to identify deviations from normal baselines without attack data, which is a fundamentally different problem in defensive network behaviour analysis [SYN-PUB-06545, SYN-PUB-05483, SYN-PUB-06542].
- [R0128] on [C061-CH1]: notes are about another person; profile can't be trusted

Shortlisted researchers with trap flags (2):

- [R1000] on [C047-CH1]: consulting_only
- [R0128] on [C061-CH1]: identity_conflict, same_name

Times the Critic stopped a claim (103, rewrites included; stopped claims go back to their author once), by check:

- quote: 25 (e.g. C001-CH1__R1008/whyThisPair/2: quote not found in R1008.bio; profile:C001-CH1__R0564/2: quote not found in SYN-PUB-06542.abstract)
- numbers: 5 (e.g. C032-CH1__R1015/whyThisPair/2: 3 is not in any cited field; profile:C032-CH1__R0071/2: 512 is not in any cited field)
- support: 73 (e.g. C001-CH1__R1008/companyBrings/1: availability under NDA not stated in the field; C001-CH1__R1008/whyThisPair/3: PhD candidate not mentioned in fields; Yocto build environment not mentioned)
