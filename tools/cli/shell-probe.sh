# Invoked explicitly with Bash or Zsh; no user startup files are loaded.
set -eu
set -o pipefail
program=$1
config=$2
node=$3
version=$4
[ "$("$program" --version)" = "prtsctl $version" ]
"$program" --config "$config" config init > /dev/null
"$program" --config "$config" config set HOST 'literal $value with spaces中文' > /dev/null
"$program" --config "$config" config set PORT 3210 > /dev/null
"$program" --config "$config" config show -o json | "$node" -e '
let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>text+=s);process.stdin.on("end",()=>{
 const fields=JSON.parse(text).fields;
 if(fields.find(x=>x.key==="HOST").value!=="literal $value with spaces中文" || fields.find(x=>x.key==="PORT").value!==3210)process.exit(1);
});'
if "$program" --not-a-valid-option > /dev/null 2>&1; then exit 1; else code=$?; fi
[ "$code" = 2 ]
printf 'CLI_SHELL_PASS\n'
