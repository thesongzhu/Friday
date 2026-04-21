#!/usr/bin/env bash

set -euo pipefail

# Read input JSON from stdin
INPUT_JSON="$(cat)"

# Extract directory path from input
DIRECTORY_PATH=$(echo "$INPUT_JSON" | jq -r '.directory_path // empty')

# Validate input
if [[ -z "$DIRECTORY_PATH" ]]; then
    echo '{"error": "directory_path is required"}' >&2
    exit 1
fi

# Check if directory exists
if [[ ! -d "$DIRECTORY_PATH" ]]; then
    echo '{"error": "Directory does not exist or is not accessible"}' >&2
    exit 1
fi

# Find largest files (cross-platform approach)
# Use find with -type f to get files only, then sort by size
largest_files_output=$(find "$DIRECTORY_PATH" -type f -exec ls -la {} + 2>/dev/null | \
    awk '{print $5 " " $9}' | \
    sort -nr | \
    head -3)

# Build JSON array of largest files
largest_files_json="[]"

if [[ -n "$largest_files_output" ]]; then
    largest_files_json="["
    first=true
    
    while IFS=' ' read -r size filepath; do
        # Skip if size is not a number (header lines, etc.)
        if [[ ! "$size" =~ ^[0-9]+$ ]]; then
            continue
        fi
        
        # Add comma separator for subsequent entries
        if [[ "$first" == "false" ]]; then
            largest_files_json="${largest_files_json},"
        fi
        first=false
        
        # Escape filepath for JSON
        escaped_filepath=$(echo "$filepath" | sed 's/\\/\\\\/g; s/"/\\"/g')
        
        # Add file entry to JSON
        largest_files_json="${largest_files_json}{\"size\":$size,\"path\":\"$escaped_filepath\",\"size_human\":\"$(numfmt --to=iec-i --suffix=B $size 2>/dev/null || echo "${size}B")\"}"
    done <<< "$largest_files_output"
    
    largest_files_json="${largest_files_json}]"
fi

# Output result JSON
echo "{\"largest_files\":$largest_files_json}"
