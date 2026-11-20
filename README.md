# Customer Interaction Triage

A system that does the first pass over customer messages (e-mails, chats and call transcripts in Czech, Slovak and English) for Merelo, a fictional Czech internet and mobile provider: it works out what each message is about, finds the customer, routes the case to the right team, and sends it to a person whenever it is unsure. Only synthetic data is used.

The project is built spec-first: what and why in [specs/mission.md](specs/mission.md), how in [specs/tech-stack.md](specs/tech-stack.md), the order of work in [specs/roadmap.md](specs/roadmap.md), and one spec folder per phase in [specs/phases/](specs/phases/). The labelled dataset and how it was built are described in [eval/data/README.md](eval/data/README.md).

How to set it up, run each step, review cases and run the evaluations is in the [guide](docs/guide.md).
