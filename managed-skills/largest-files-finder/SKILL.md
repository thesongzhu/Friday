# Largest Files Finder

List the top 3 largest files in a given directory

## Overview

This skill analyzes a directory and returns the 3 largest files by size, providing both raw byte counts and human-readable size formatting.

## Usage

### Input
- `directory_path` (string, required): The path to the directory to analyze

### Output
- `largest_files` (array): Array of up to 3 largest files, each containing:
  - `size`: File size in bytes
  - `path`: Full file path
  - `size_human`: Human-readable size (e.g., "1.2MB")

## Examples

### Basic Usage
```json
{
  "directory_path": "/home/user/documents"
}
```

### Expected Output
```json
{
  "largest_files": [
    {
      "size": 1048576,
      "path": "/home/user/documents/large_file.pdf",
      "size_human": "1.0MiB"
    },
    {
      "size": 524288,
      "path": "/home/user/documents/medium_file.docx",
      "size_human": "512KiB"
    },
    {
      "size": 262144,
      "path": "/home/user/documents/small_file.txt",
      "size_human": "256KiB"
    }
  ]
}
```

## Features

- Cross-platform compatibility (Linux, macOS, Windows)
- Human-readable file size formatting
- Handles directories with special characters in filenames
- Graceful error handling for inaccessible directories
- Recursive search through subdirectories

## Error Handling

- Returns error if directory path is not provided
- Returns error if directory does not exist or is not accessible
- Skips files that cannot be accessed due to permissions

## Technical Notes

- Uses `find` command for cross-platform file discovery
- Sorts files by size in descending order
- Limits results to top 3 largest files
- Provides both raw byte count and human-readable formatting
