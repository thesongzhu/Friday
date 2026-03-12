#!/usr/bin/env bash

# Output the current date and time in ISO format as JSON
currentDateTime=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "{ \"currentDateTime\": \"$currentDateTime\" }"