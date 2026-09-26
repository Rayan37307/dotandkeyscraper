#!/usr/bin/env python3
"""Convert a scraper CSV to Matrixify format and split it into batches.

Matrixify's free (demo) plan imports 10 items per job, and an item is a
product, not a row. This keeps each product's rows together in one file.

Usage: split_matrixify.py INPUT.csv [OUT_DIR] [--per-file N]
"""
import argparse
import csv
import os

NATIVE_HEADER = 'Product Data (product.metafields.custom.product_data)'
MATRIXIFY_HEADER = 'Metafield: custom.product_data [json]'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('out_dir', nargs='?')
    ap.add_argument('--per-file', type=int, default=10)
    args = ap.parse_args()

    with open(args.input, encoding='utf-8-sig', newline='') as f:
        rows = list(csv.reader(f))
    header, data = rows[0], rows[1:]
    header = [MATRIXIFY_HEADER if c == NATIVE_HEADER else c for c in header]

    # Group rows by Handle, preserving order
    products = {}
    for r in data:
        products.setdefault(r[0], []).append(r)
    handles = list(products)

    out_dir = args.out_dir or os.path.splitext(args.input)[0] + '-matrixify'
    os.makedirs(out_dir, exist_ok=True)
    batches = [handles[i:i + args.per_file] for i in range(0, len(handles), args.per_file)]
    for n, batch in enumerate(batches, 1):
        path = os.path.join(out_dir, f'matrixify-batch-{n:02d}-of-{len(batches):02d}.csv')
        with open(path, 'w', encoding='utf-8', newline='') as f:
            w = csv.writer(f, lineterminator='\r\n')
            w.writerow(header)
            for h in batch:
                w.writerows(products[h])
        rows_in = sum(len(products[h]) for h in batch)
        print(f'{path}: {len(batch)} products, {rows_in} rows')


if __name__ == '__main__':
    main()
