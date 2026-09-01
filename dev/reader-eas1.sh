#!/bin/bash
# dev fixture — mimics a pagermon client reader.sh
GAIN=42
PPM=0
rtl_fm -d 0 -f 148.5375M -M fm -s 22050 -g $GAIN -p $PPM -E dc - \
  | multimon-ng -a POCSAG512 -a POCSAG1200 -a POCSAG2400 -f alpha -t raw - \
  | node reader.js
