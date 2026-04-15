# Extract Action Items

## Description
Extract a list of action items with owners and deadlines from a meeting transcript.

## Inputs
- **Meeting Transcript** (string, required): The transcript of the meeting from which action items will be extracted.

## Outputs
- **actionItems** (array): A list of action items with associated owners and deadlines.

## Example
Given a transcript:
```
[John Doe] Prepare the report by next week due 2023-10-15
[Jane Smith] Follow up with the client due 2023-10-20
```
The output will be:
```json
[
  { "owner": "John Doe", "action": "Prepare the report", "deadline": "2023-10-15" },
  { "owner": "Jane Smith", "action": "Follow up with the client", "deadline": "2023-10-20" }
]
```