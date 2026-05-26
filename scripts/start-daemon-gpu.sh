#!/bin/bash
cd /home/likkmrl/cabinet
export QMD_LLAMA_GPU=cuda
export NODE_LLAMA_CPP_GPU=cuda
exec node scripts/dev-daemon.mjs
