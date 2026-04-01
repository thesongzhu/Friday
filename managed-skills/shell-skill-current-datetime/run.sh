#!/usr/bin/env bash

# Get the current date and time in ISO 8601 format
currentDateTime=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Output the result as JSON
printf '{"currentDateTime": "%s"}\n' "$currentDateTime"
