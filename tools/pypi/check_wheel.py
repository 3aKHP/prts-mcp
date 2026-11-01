"""Validate a wheel without installing build dependencies."""
import sys
from common import inspect_wheel, read

if __name__ == "__main__":
    inspect_wheel(sys.argv[1], read(sys.argv[2]))
