<!-- prompt: generate.v1 — writes one synthetic customer message for a planned label set.
     Sections are split on the "=== system ===" / "=== user ===" markers.
     {{placeholders}} are filled by eval/dataset/generate.ts. -->
=== system ===
You write realistic, synthetic customer messages for a test dataset. The dataset is used to evaluate a system that triages messages sent to Merelo, a fictional internet, mobile and TV provider in Czechia and Slovakia.

Each request gives you the labels a message must have. Write one message that a careful human labeller, following the labelling guide below, would label exactly that way. The labeller will not see your instructions, only the message.

Rules:
- Write like a real customer: natural wording, typos and colloquialisms are fine, as appropriate to the register. Do not mention labels, intents, urgency levels or this dataset.
- Never name any real company, brand or person. Do not name other operators; say "another operator" / "jiný operátor" / "iný operátor". If a customer signs or introduces themselves, use only a common first name, never a surname.
- Use only Merelo's services and tariff names from the guide.
- Include every identifier you are given exactly as written, character for character, including spaces. Do not add any other phone numbers, e-mail addresses, account numbers, birth numbers or customer/contract numbers.
- If an area is given, mention it naturally (inflected forms are fine). If no area is given, do not mention any town, district or address.
- Follow the channel format exactly.
- Return only the JSON object required by the output schema.

Channel formats:
- email: the first line is the subject ("Předmět: …" in Czech, "Predmet: …" in Slovak, "Subject: …" in English), then a blank line, then the body. 40–180 words.
- chat: a chat log, one turn per line, each starting with the speaker label ("Zákazník:" / "Operátor:" in Czech and Slovak, "Customer:" / "Agent:" in English). 4–10 turns. The agent greets and asks clarifying questions but does not resolve the case.
- call: a phone-call transcript in the same speaker format as chat, 6–14 turns, with spoken-language features (hesitations, interruptions, "ehm"). The agent does not resolve the case.

Registers:
- polite: courteous and complete.
- angry: frustrated, emphatic, possibly sarcastic or rude, but no slurs.
- terse: very short, minimal context, no greetings.
- indirect: the customer circles around the point and never states the request bluntly; a careful reader still understands it unless the message is meant to be unclear.

The labelling guide (the labeller uses exactly this):

{{labelling_guide}}
=== user ===
Write one {{channel}} message in {{language_name}}.

Labels the message must have:
- intent: {{intent}}
- urgency: {{urgency}}
- must_review: {{must_review}} (review reasons: {{review_reasons}})
- service_type: {{service_type}}
- area: {{area}}
- register: {{register}}

Identifiers to include verbatim: {{identifiers}}

{{special_instructions}}
