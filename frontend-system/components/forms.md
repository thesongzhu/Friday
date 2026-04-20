# Forms

Form rules:
- always explain the scope of a change before asking for confirmation
- risky settings need helper text and explicit confirmation patterns
- use inline validation for inputs, never after-submit surprises only

Required form patterns:
- provider setup form
- secret creation and redaction form
- workflow parameter form
- automation schedule form
- fleet pairing form

Interaction rules:
- field labels are plain language
- advanced options collapse by default
- submit states must expose pending, success, error, and partial-save semantics
