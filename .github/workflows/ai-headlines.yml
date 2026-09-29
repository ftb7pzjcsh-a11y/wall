name: AI headlines

on:
  schedule:
    - cron: "*/30 * * * *"
  workflow_dispatch:

permissions:
  contents: write
  models: read

concurrency:
  group: ai-headlines
  cancel-in-progress: false

jobs:
  headlines:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Write headlines
        run: node scripts/ai-headlines.mjs
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Save ai.json
        run: |
          if [ -f ai.json ] && [ -n "$(git status --porcelain ai.json)" ]; then
            git config user.name "github-actions[bot]"
            git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
            git add ai.json
            git commit -m "Update AI headlines"
            git pull --rebase --autostash
            git push
          else
            echo "Nothing to save."
          fi
