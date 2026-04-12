#!/usr/bin/env bash
set -euo pipefail

COMMAND="${FRIDAY_INPUT_COMMAND:-}"

case "$COMMAND" in
  "Preamble run first")
    _UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
    [ -n "$_UPD" ] && echo "$_UPD" || true
    mkdir -p ~/.gstack/sessions
    touch ~/.gstack/sessions/"$PPID"
    _SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
    find ~/.gstack/sessions -mmin +120 -type f -delete 2>/dev/null || true
    _CONTRIB=$(~/.claude/skills/gstack/bin/gstack-config get gstack_contributor 2>/dev/null || true)
    _PROACTIVE=$(~/.claude/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
    _BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
    echo "BRANCH: $_BRANCH"
    echo "PROACTIVE: $_PROACTIVE"
    source <(~/.claude/skills/gstack/bin/gstack-repo-mode 2>/dev/null) || true
    REPO_MODE=${REPO_MODE:-unknown}
    echo "REPO_MODE: $REPO_MODE"
    _LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
    echo "LAKE_INTRO: $_LAKE_SEEN"
    _TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || true)
    _TEL_PROMPTED=$([ -f ~/.gstack/.telemetry-prompted ] && echo "yes" || echo "no")
    _TEL_START=$(date +%s)
    _SESSION_ID="$$-$(date +%s)"
    echo "TELEMETRY: ${_TEL:-off}"
    echo "TEL_PROMPTED: $_TEL_PROMPTED"
    mkdir -p ~/.gstack/analytics
    echo '{"skill":"gstack","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
    # zsh-compatible: use find instead of glob to avoid NOMATCH error
    for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do [ -f "$_PF" ] && ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true; break; done
    ;;
  "Then offer to open the essay in their default browser")
    open https://garryslist.org/posts/boil-the-ocean
    touch ~/.gstack/.completeness-intro-seen
    ;;
  "Always run")
    touch ~/.gstack/.telemetry-prompted
    ;;
  "To file: write /.gstack/contributor-logs/slug.md")
    # {Title}
    **What I tried:** {action} | **What happened:** {result} | **Rating:** {0-10}
    ## Repro
    1. {step}
    ## What would make this a 10
    {one sentence}
    **Date:** {YYYY-MM-DD} | **Version:** {version} | **Skill:** /{skill}
    ;;
  "Escalation format")
    STATUS: BLOCKED | NEEDS_CONTEXT
    REASON: [1-2 sentences]
    ATTEMPTED: [what you tried]
    RECOMMENDATION: [what the user should do next]
    ;;
  "Run this bash")
    _TEL_END=$(date +%s)
    _TEL_DUR=$(( _TEL_END - _TEL_START ))
    rm -f ~/.gstack/analytics/.pending-"$_SESSION_ID" 2>/dev/null || true
    ~/.claude/skills/gstack/bin/gstack-telemetry-log \
      --skill "SKILL_NAME" --duration "$_TEL_DUR" --outcome "OUTCOME" \
      --used-browse "USED_BROWSE" --session-id "$_SESSION_ID" 2>/dev/null &
    ;;
  "SETUP run this check BEFORE any browse command")
    _ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
    B=""
    [ -n "$_ROOT" ] && [ -x "$_ROOT/.claude/skills/gstack/browse/dist/browse" ] && B="$_ROOT/.claude/skills/gstack/browse/dist/browse"
    [ -z "$B" ] && B=~/.claude/skills/gstack/browse/dist/browse
    if [ -x "$B" ]; then
      echo "READY: $B"
    else
      echo "NEEDS_SETUP"
    fi
    ;;
  "Test a user flow login, signup, checkout, etc.")
    # 1. Go to the page
    $B goto https://app.example.com/login
    
    # 2. See what's interactive
    $B snapshot -i
    
    # 3. Fill the form using refs
    $B fill @e3 "test@example.com"
    $B fill @e4 "password123"
    $B click @e5
    
    # 4. Verify it worked
    $B snapshot -D              # diff shows what changed after clicking
    $B is visible ".dashboard"  # assert the dashboard appeared
    $B screenshot /tmp/after-login.png
    ;;
  "Verify a deployment / check prod")
    $B goto https://yourapp.com
    $B text                          # read the page — does it load?
    $B console                       # any JS errors?
    $B network                       # any failed requests?
    $B js "document.title"           # correct title?
    $B is visible ".hero-section"    # key elements present?
    $B screenshot /tmp/prod-check.png
    ;;
  "Dogfood a feature end-to-end")
    # Navigate to the feature
    $B goto https://app.example.com/new-feature
    
    # Take annotated screenshot — shows every interactive element with labels
    $B snapshot -i -a -o /tmp/feature-annotated.png
    
    # Find ALL clickable things (including divs with cursor:pointer)
    $B snapshot -C
    
    # Walk through the flow
    $B snapshot -i          # baseline
    $B click @e3            # interact
    $B snapshot -D          # what changed? (unified diff)
    
    # Check element states
    $B is visible ".success-toast"
    $B is enabled "#next-step-btn"
    $B is checked "#agree-checkbox"
    
    # Check console for errors after interactions
    $B console
    ;;
  "Test responsive layouts")
    # Quick: 3 screenshots at mobile/tablet/desktop
    $B goto https://yourapp.com
    $B responsive /tmp/layout
    
    # Manual: specific viewport
    $B viewport 375x812     # iPhone
    $B screenshot /tmp/mobile.png
    $B viewport 1440x900    # Desktop
    $B screenshot /tmp/desktop.png
    
    # Element screenshot (crop to specific element)
    $B screenshot "#hero-banner" /tmp/hero.png
    $B snapshot -i
    $B screenshot @e3 /tmp/button.png
    
    # Region crop
    $B screenshot --clip 0,0,800,600 /tmp/above-fold.png
    
    # Viewport only (no scroll)
    $B screenshot --viewport /tmp/viewport.png
    ;;
  "Test file upload")
    $B goto https://app.example.com/upload
    $B snapshot -i
    $B upload @e3 /path/to/test-file.pdf
    $B is visible ".upload-success"
    $B screenshot /tmp/upload-result.png
    ;;
  "Test forms with validation")
    $B goto https://app.example.com/form
    $B snapshot -i
    
    # Submit empty — check validation errors appear
    $B click @e10                        # submit button
    $B snapshot -D                       # diff shows error messages appeared
    $B is visible ".error-message"
    
    # Fill and resubmit
    $B fill @e3 "valid input"
    $B click @e10
    $B snapshot -D                       # diff shows errors gone, success state
    ;;
  "Test dialogs delete confirmations, prompts")
    # Set up dialog handling BEFORE triggering
    $B dialog-accept              # will auto-accept next alert/confirm
    $B click "#delete-button"     # triggers confirmation dialog
    $B dialog                     # see what dialog appeared
    $B snapshot -D                # verify the item was deleted
    
    # For prompts that need input
    $B dialog-accept "my answer"  # accept with text
    $B click "#rename-button"     # triggers prompt
    ;;
  "Test authenticated pages import real browser cookies")
    # Import cookies from your real browser (opens interactive picker)
    $B cookie-import-browser
    
    # Or import a specific domain directly
    $B cookie-import-browser comet --domain .github.com
    
    # Now test authenticated pages
    $B goto https://github.com/settings/profile
    $B snapshot -i
    $B screenshot /tmp/github-profile.png
    ;;
  "Compare two pages / environments")
    $B diff https://staging.app.com https://prod.app.com
    ;;
  "Multi-step chain efficient for long flows")
    echo '[
      ["goto","https://app.example.com"],
      ["snapshot","-i"],
      ["fill","@e3","test@test.com"],
      ["fill","@e4","password"],
      ["click","@e5"],
      ["snapshot","-D"],
      ["screenshot","/tmp/result.png"]
    ]' | $B chain
    ;;
  "Quick Assertion Patterns")
    # Element exists and is visible
    $B is visible ".modal"
    
    # Button is enabled/disabled
    $B is enabled "#submit-btn"
    $B is disabled "#submit-btn"
    
    # Checkbox state
    $B is checked "#agree"
    
    # Input is editable
    $B is editable "#name-field"
    
    # Element has focus
    $B is focused "#search-input"
    
    # Page contains text
    $B js "document.body.textContent.includes('Success')"
    
    # Element count
    $B js "document.querySelectorAll('.list-item').length"
    
    # Specific attribute value
    $B attrs "#logo"    # returns all attributes as JSON
    
    # CSS property
    $B css ".button" "background-color"
    ;;
  "The snapshot is your primary tool for understanding and interacting with pages.")
    -i        --interactive           Interactive elements only (buttons, links, inputs) with @e refs
    -c        --compact               Compact (no empty structural nodes)
    -d <N>    --depth                 Limit tree depth (0 = root only, default: unlimited)
    -s <sel>  --selector              Scope to CSS selector
    -D        --diff                  Unified diff against previous snapshot (first call stores baseline)
    -a        --annotate              Annotated screenshot with red overlay boxes and ref labels
    -o <path> --output                Output path for annotated screenshot (default: <temp>/browse-annotated.png)
    -C        --cursor-interactive    Cursor-interactive elements (@c refs — divs with pointer, onclick)
    ;;
  "After snapshot, use @refs as selectors in any command")
    $B click @e3       $B fill @e4 "value"     $B hover @e1
    $B html @e2        $B css @e5 "color"      $B attrs @e6
    $B click @c1       # cursor-interactive ref (from -C)
    ;;
  "Output format: indented accessibility tree with @ref IDs, one element per line.")
    @e1 [heading] "Welcome" [level=1]
      @e2 [textbox] "Email"
      @e3 [button] "Submit"
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    echo "Available commands:" >&2
    echo "  - Preamble run first" >&2
    echo "  - Then offer to open the essay in their default browser" >&2
    echo "  - Always run" >&2
    echo "  - To file: write /.gstack/contributor-logs/slug.md" >&2
    echo "  - Escalation format" >&2
    echo "  - Run this bash" >&2
    echo "  - SETUP run this check BEFORE any browse command" >&2
    echo "  - Test a user flow login, signup, checkout, etc." >&2
    echo "  - Verify a deployment / check prod" >&2
    echo "  - Dogfood a feature end-to-end" >&2
    echo "  - Test responsive layouts" >&2
    echo "  - Test file upload" >&2
    echo "  - Test forms with validation" >&2
    echo "  - Test dialogs delete confirmations, prompts" >&2
    echo "  - Test authenticated pages import real browser cookies" >&2
    echo "  - Compare two pages / environments" >&2
    echo "  - Multi-step chain efficient for long flows" >&2
    echo "  - Quick Assertion Patterns" >&2
    echo "  - The snapshot is your primary tool for understanding and interacting with pages." >&2
    echo "  - After snapshot, use @refs as selectors in any command" >&2
    echo "  - Output format: indented accessibility tree with @ref IDs, one element per line." >&2
    exit 1
    ;;
esac
