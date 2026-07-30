<#
.SYNOPSIS
    Creates (or moves) the "Atlas Delivery" GitHub Project at the atlasms ORG level and
    configures its fields.

.DESCRIPTION
    Idempotent: safe to re-run. It will
      1. verify the `project` scope is present,
      2. find an existing org project, or MOVE a user-level one up to the org, or create a new one,
      3. link the docs repo,
      4. create the Phase / Estimate / Service / Requirement fields if missing,
      5. print the remaining manual (web-UI-only) steps.

    It never deletes anything. If a user-level copy is left behind after a move, it tells you
    and lets you delete it yourself.

    Design: docs/roadmap/20-delivery-process.md#9-github-setup-commands

.EXAMPLE
    pwsh ./scripts/setup-github-project.ps1
    pwsh ./scripts/setup-github-project.ps1 -Org atlasms -Repo docs -Title "Atlas Delivery"
#>
[CmdletBinding()]
param(
    [string]$Org   = 'atlasms',
    [string]$Repo  = 'platform',
    [string]$Title = 'Atlas Delivery',

    # Iteration (sprint) generation. 31 x 2 weeks covers the T0-T62 roadmap span.
    [string]$IterationStart = '2026-07-30',
    [int]   $IterationCount = 31
)

$ErrorActionPreference = 'Stop'

# --- locate gh -------------------------------------------------------------
$gh = (Get-Command gh -ErrorAction SilentlyContinue)?.Source
if (-not $gh) {
    $fallback = "$env:ProgramFiles\GitHub CLI\gh.exe"
    if (Test-Path $fallback) { $gh = $fallback } else { throw "gh CLI not found on PATH." }
}
function Invoke-Gh { & $gh @args }

Write-Host "==> Using gh at $gh" -ForegroundColor Cyan

# --- 1. scope check --------------------------------------------------------
# Match the exact quoted scope token: 'project'. Deliberately NOT a \bproject\b match,
# which would also accept the read-only 'read:project' scope and then fail at create time.
$authOut = (Invoke-Gh auth status 2>&1 | Out-String)
if ($authOut -notmatch "'project'") {
    Write-Host @"

  The token is missing the 'project' scope, which is required to create or edit Projects.
  Run this ONCE (it is interactive and opens a browser), then re-run this script:

      gh auth refresh -s project

"@ -ForegroundColor Yellow
    throw "Missing 'project' scope."
}
Write-Host "==> 'project' scope present" -ForegroundColor Green

# --- 2. find / move / create ----------------------------------------------
function Get-ProjectByTitle([string]$owner, [string]$title) {
    $json = Invoke-Gh project list --owner $owner --format json 2>$null
    if (-not $json) { return $null }
    return ($json | ConvertFrom-Json).projects | Where-Object { $_.title -eq $title } | Select-Object -First 1
}

$orgProject = Get-ProjectByTitle $Org $Title

if ($orgProject) {
    Write-Host "==> Org project already exists: #$($orgProject.number) '$Title' (owner: $Org)" -ForegroundColor Green
}
else {
    $userProject = Get-ProjectByTitle '@me' $Title
    if ($userProject) {
        Write-Host "==> Found a USER-level project #$($userProject.number) '$Title' - copying it to the org..." -ForegroundColor Yellow
        Invoke-Gh project copy $userProject.number --source-owner '@me' --target-owner $Org --title $Title --drafts | Out-Null
        $orgProject = Get-ProjectByTitle $Org $Title
        if (-not $orgProject) { throw "Copy to org appeared to succeed but the project was not found." }
        Write-Host "==> Copied to org as #$($orgProject.number)." -ForegroundColor Green
        Write-Host "    The original user-level project #$($userProject.number) still exists." -ForegroundColor Yellow
        Write-Host "    Delete it yourself once you've confirmed the copy looks right:" -ForegroundColor Yellow
        Write-Host "      gh project delete $($userProject.number) --owner '@me'" -ForegroundColor Yellow
    }
    else {
        Write-Host "==> Creating project '$Title' at the ORG level ($Org)..." -ForegroundColor Cyan
        Invoke-Gh project create --owner $Org --title $Title | Out-Null
        $orgProject = Get-ProjectByTitle $Org $Title
        if (-not $orgProject) { throw "Project creation appeared to succeed but the project was not found." }
        Write-Host "==> Created #$($orgProject.number)." -ForegroundColor Green
    }
}

$N = $orgProject.number

# --- 3. link the repo ------------------------------------------------------
Write-Host "==> Linking $Org/$Repo to project #$N ..." -ForegroundColor Cyan
try { Invoke-Gh project link $N --owner $Org --repo $Repo | Out-Null; Write-Host "    linked." -ForegroundColor Green }
catch { Write-Host "    already linked (or link failed harmlessly): $($_.Exception.Message)" -ForegroundColor DarkGray }

# --- 4. fields (idempotent) ------------------------------------------------
$existing = (Invoke-Gh project field-list $N --owner $Org --format json | ConvertFrom-Json).fields
function Ensure-Field {
    param([string]$Name, [string]$DataType, [string]$Options)
    if ($existing | Where-Object { $_.name -eq $Name }) {
        Write-Host "    field '$Name' already exists - skipping" -ForegroundColor DarkGray
        return
    }
    Write-Host "    creating field '$Name' ($DataType)" -ForegroundColor Cyan
    if ($Options) {
        Invoke-Gh project field-create $N --owner $Org --name $Name --data-type $DataType --single-select-options $Options | Out-Null
    } else {
        Invoke-Gh project field-create $N --owner $Org --name $Name --data-type $DataType | Out-Null
    }
}

Write-Host "==> Ensuring fields..." -ForegroundColor Cyan
Ensure-Field -Name 'Phase'   -DataType 'SINGLE_SELECT' -Options 'Phase 0,Phase 1 (MVP),Phase 2 (Beta),Phase 3 (v1.0),GA,v2.0'
Ensure-Field -Name 'Estimate' -DataType 'NUMBER'
Ensure-Field -Name 'Service' -DataType 'SINGLE_SELECT' -Options 'mam,hsm,mts,rim,iam,scheduling,bms,notifications,newsroom,integration,ai,logging,gateway,websocket,studio,shared'
Ensure-Field -Name 'Requirement' -DataType 'TEXT'

# --- 5. iterations S01..S31 (GraphQL - gh project cannot do ITERATION) -----
# `gh project field-create` has no ITERATION data type, but the GraphQL mutation
# updateProjectV2Field accepts an iterationConfiguration. The Iteration FIELD itself must
# already exist (create it once in the UI); this regenerates its iterations.
$projectId = $orgProject.id
$qIter = @'
query($org:String!,$num:Int!){ organization(login:$org){ projectV2(number:$num){
  field(name:"Iteration"){ ... on ProjectV2IterationField { id configuration{ iterations{ title } } } } } } }
'@
$iterField = (Invoke-Gh api graphql -f query=$qIter -F org=$Org -F num=$N | ConvertFrom-Json).data.organization.projectV2.field

if (-not $iterField.id) {
    Write-Host "==> No 'Iteration' field yet - create it once in the UI, then re-run:" -ForegroundColor Yellow
    Write-Host "    https://github.com/orgs/$Org/projects/$N/settings  ->  + New field -> Iteration (2 weeks)" -ForegroundColor Yellow
}
elseif ($iterField.configuration.iterations.Count -ge $IterationCount) {
    Write-Host "==> Iteration field already has $($iterField.configuration.iterations.Count) iterations - skipping" -ForegroundColor DarkGray
}
else {
    $itemCount = (Invoke-Gh project item-list $N --owner $Org --format json | ConvertFrom-Json).items.Count
    if ($itemCount -gt 0) {
        Write-Host "==> Project has $itemCount items; NOT rewriting iterations (would drop their assignments)." -ForegroundColor Yellow
        Write-Host "    Add the remaining iterations in the UI instead." -ForegroundColor Yellow
    }
    else {
        Write-Host "==> Generating $IterationCount iterations (S01..S$('{0:d2}' -f $IterationCount)) from $IterationStart ..." -ForegroundColor Cyan
        $start = [datetime]$IterationStart
        $list  = 0..($IterationCount - 1) | ForEach-Object {
            '{{startDate:"{0}",duration:14,title:"S{1:d2}"}}' -f $start.AddDays(14 * $_).ToString('yyyy-MM-dd'), ($_ + 1)
        }
        $mIter = @"
mutation { updateProjectV2Field(input:{ fieldId:"$($iterField.id)",
  iterationConfiguration:{ startDate:"$($start.ToString('yyyy-MM-dd'))", duration:14, iterations:[$($list -join ',')] } })
  { projectV2Field{ ... on ProjectV2IterationField { configuration{ iterations{ title } } } } } }
"@
        $res = Invoke-Gh api graphql -f query=$mIter
        $made = ($res | ConvertFrom-Json).data.updateProjectV2Field.projectV2Field.configuration.iterations.Count
        Write-Host "    created $made iterations." -ForegroundColor Green
    }
}

# --- 6. views (GraphQL - not exposed by `gh project`) ----------------------
$qViews = @'
query($org:String!,$num:Int!){ organization(login:$org){ projectV2(number:$num){ views(first:20){ nodes{ id name } } } } }
'@
$existingViews = (Invoke-Gh api graphql -f query=$qViews -F org=$Org -F num=$N | ConvertFrom-Json).data.organization.projectV2.views.nodes

$viewSpecs = @(
    @{ name = 'Board';     layout = 'BOARD_LAYOUT';   filter = 'iteration:@current' },
    @{ name = 'Iteration'; layout = 'TABLE_LAYOUT';   filter = 'iteration:@current' },
    @{ name = 'Epics';     layout = 'TABLE_LAYOUT';   filter = 'type:Epic' },
    @{ name = 'Roadmap';   layout = 'ROADMAP_LAYOUT'; filter = '' },
    @{ name = 'Blocked';   layout = 'TABLE_LAYOUT';   filter = 'status:Blocked' }
)

Write-Host "==> Ensuring views..." -ForegroundColor Cyan
foreach ($s in $viewSpecs) {
    if ($existingViews | Where-Object { $_.name -eq $s.name }) {
        Write-Host "    view '$($s.name)' already exists - skipping" -ForegroundColor DarkGray
        continue
    }
    # reuse the stock "View 1" for the first spec rather than leaving it orphaned
    $stock = $existingViews | Where-Object { $_.name -eq 'View 1' } | Select-Object -First 1
    if ($stock) {
        $m = "mutation { updateProjectV2View(input:{ viewId:`"$($stock.id)`", name:`"$($s.name)`", layout:$($s.layout)" +
             $(if ($s.filter) { ", filter:`"$($s.filter)`"" } else { '' }) + " }){ projectV2View{ id } } }"
        Invoke-Gh api graphql -f query=$m | Out-Null
        $existingViews = $existingViews | Where-Object { $_.id -ne $stock.id }
        Write-Host "    repurposed 'View 1' as '$($s.name)'" -ForegroundColor Green
        continue
    }
    $m = "mutation { createProjectV2View(input:{ projectId:`"$projectId`", name:`"$($s.name)`", layout:$($s.layout) }){ projectV2View{ id } } }"
    $v = (Invoke-Gh api graphql -f query=$m | ConvertFrom-Json).data.createProjectV2View.projectV2View
    if ($s.filter) {
        $m2 = "mutation { updateProjectV2View(input:{ viewId:`"$($v.id)`", filter:`"$($s.filter)`" }){ projectV2View{ id } } }"
        Invoke-Gh api graphql -f query=$m2 | Out-Null
    }
    Write-Host "    created view '$($s.name)'" -ForegroundColor Green
}

# --- 7. what genuinely cannot be scripted ----------------------------------
$url = "https://github.com/orgs/$Org/projects/$N"
Write-Host @"

============================================================
  Project ready: $url
  (org-owned: $Org, number: $N)
============================================================

These four CANNOT be set by any API and must be checked in the UI:

  1. STATUS VALUES - the built-in Status field cannot be recreated by CLI.
     Confirm it reads: Backlog, Ready, In Progress, In Review, Verifying, Done, Blocked

  2. VIEW GROUPING - the API exposes only visibleFieldIds, not group-by.
     Board -> group by Status | Epics -> group by Phase | Roadmap -> marker Iteration

  3. WORKFLOW ACTIONS - ProjectV2Workflow exposes name/enabled only, never the target.
     $url/workflows -> confirm: item added -> Backlog | closed -> Done | PR merged -> Verifying

  4. ISSUE TYPES (org admin, one time)
     https://github.com/organizations/$Org/settings/issue-types
       Epic, Story, Spike, Chore  (alongside default Bug/Task/Feature)

See docs/roadmap/20-delivery-process.md for the board, fields and views design.
"@ -ForegroundColor White
