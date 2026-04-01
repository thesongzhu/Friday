#!/usr/bin/env bash

# Get the current date and time in ISO 8601 format
current_date_time=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Output the result as JSON
printf '{"dateTime": "%s"}\n' "$current_date_time"
