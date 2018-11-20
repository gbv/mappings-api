#!/bin/bash

# Instructions:
# 1. Create files import_concepts.txt / import_mappings.txt / import_terminologies.txt
#    with one line for each file or URL to be imported (lines starting with # are ignored)
# 2. Make script executable: $ chmod +x import.sh
# 3. run $ ./scripts/import.sh /path/to/jskos-server
#    IF script is not under scripts/ in jskos-server, you need to specify its path:
#    $ ./scripts/import.sh /path/to/jskos-server

CURRENT_DIR=$(dirname $(realpath $0))
IMPORT_DIR=$CURRENT_DIR"/.files_to_import"
# Server directory
if [ "$#" -eq  "0" ]
  then
    SERVER_DIR=$CURRENT_DIR"/.."
  else
    SERVER_DIR=$1
fi
if [[ ! -d $SERVER_DIR ]]; then
  echo "Server directory does not exist."
  exit 1
fi

# Logging
LOGFILE=$CURRENT_DIR"/import.log"
log() {
  echo "$(date): $1" >> $LOGFILE
}
log "----- Import started. -----"

# Create import directory
[[ -d $IMPORT_DIR ]] || mkdir $IMPORT_DIR

cd $SERVER_DIR

# Define function for download and import
# Usage: download_import -m ${FILES[@]}
# (replace -m with -t for terminologies or -c for concepts)
download_import() {
  local OPT=$1
  shift
  local FILES=($@)
  ## Remove all existing items except for mappings
  [[ $OPT == "-m" ]] || npm run import -- -r $OPT
  ## Rebuild indexes for all types
  npm run import -- -i $OPT
  ## Download and import
  for FILE in ${FILES[@]}; do
    if [[ $FILE == \#* ]];
    then
      echo
      echo "##### Skipping $FILE #####"
      echo
      continue
    fi
    echo
    echo "##### Importing $FILE #####"
    ### Import file
    npm rum import -- $OPT $FILE
    ### Log on error
    if [ $? -ne 0 ]; then
      log "ERROR: Failed to import $FILE."
    fi
  done
}

OLD_IFS=$IFS
IFS=$'\n'

# Import concordances
FILES=( $(cat $CURRENT_DIR/import_concordances.txt | grep "^[^#;]") )
if [ -n "$FILES" ]; then
  download_import -k ${FILES[@]}
fi

# Import mappings
FILES=( $(cat $CURRENT_DIR/import_mappings.txt | grep "^[^#;]") )
if [ -n "$FILES" ]; then
  download_import -m ${FILES[@]}
fi

# Import terminologies
FILES=( $(cat $CURRENT_DIR/import_terminologies.txt | grep "^[^#;]") )
if [ -n "$FILES" ]; then
  download_import -t ${FILES[@]}
fi

# Import concepts
FILES=( $(cat $CURRENT_DIR/import_concepts.txt | grep "^[^#;]") )
if [ -n "$FILES" ]; then
  download_import -c ${FILES[@]}
fi

IFS=$OLD_IFS
# Delete import directory
rm -r $IMPORT_DIR
cd $CURRENT_DIR

log "----- Import finished. -----"

echo "##### Importing done! #####"
