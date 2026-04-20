# Chat

Target users:
- all users starting or steering work through conversation

Page tasks:
- start a new task
- inspect run steps
- review tool activity and results
- branch into follow-up actions

Module order:
1. Conversation header and task framing
2. Main message stream
3. Inline run activity and tool receipts
4. Action cards and generated outputs
5. Related context drawer or sidebar modules

Desktop layout:
- expanded center conversation replaces the compact right rail
- supplemental activity stays visible beside or below the stream

Mobile mapping:
- fullscreen conversation
- collapsible activity sheet
- sticky composer

Right-rail chat linkage:
- `/chat` is the expanded rail model
- preserve the same session id and context stack

States:
- loading: skeleton thread and activity placeholders
- empty: guided examples and suggested prompts
- error: preserve draft and failure explanation
- partial: thread visible with missing receipts called out
- success: thread, activity, and action outputs in sync

Forbidden:
- no separate mobile chat product
- no result that appears only in the transcript
- no tool log dump without summarized user meaning
