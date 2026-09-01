#!/bin/bash
# dev fixture — this one uses a FREQ= variable instead of an inline -f
FREQ=148.7875M
rtl_fm -d 1 -f $FREQ -M fm -s 22050 -g 40 -p 0 -E dc - \
  | multimon-ng -a POCSAG512 -f alpha -t raw - \
  | node reader.js
