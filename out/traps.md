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

- [R0128] on [C061-CH1]: notes are about another person; profile can't be trusted

Shortlisted researchers with trap flags (1):

- [R0128] on [C061-CH1]: identity_conflict, same_name

Times the Critic stopped a claim (67, rewrites included; stopped claims go back to their author once), by check:

- quote: 9 (e.g. profile:C001-CH1__R0817/2: quote not found in SYN-PUB-08881.abstract; profile:C001-CH1__R1008/1: quote not found in SYN-PUB-10477.abstract)
- policy: 1 (e.g. profile:C001-CH1__R1015/3: ranks or praises a person)
- numbers: 5 (e.g. profile:C001-CH1__R0634/2: 7 is not in any quoted source; profile:C001-CH1__R1015/2: 94 is not in any quoted source)
- support: 52 (e.g. C001-CH1__R1015/companyBrings/1: Quote says 'several terabytes', claim says 'multi-terabyte' which is vaguer but acceptable; however claim adds 'over three years' as a specific timeframe detail.; C001-CH1__R1015/companyBrings/1: Quotes say 'captures' but claim specifies these are 'real Modbus TCP and BACnet/IP traffic'; protocol types not mentioned in quote)
