# Dot & Key Product Scraper → Shopify CSV

## Install
1. Unzip. Open `chrome://extensions`, turn on **Developer mode**.
2. Click **Load unpacked** and pick the unzipped folder.

## Use
- On a product page: click the extension, then **Scrape this product**.
- On any page (e.g. /collections/shop-all): set the collection handle, then **Scrape whole collection**.
- A progress panel appears at the bottom right of the page, and the files download when it finishes.
  You can close the popup while it runs, but leave the tab open.

Outputs:
- `dotandkey-<name>-<time>.csv`: a Shopify product import CSV (variants, prices, SKUs, barcodes, images, SEO)
- `dotandkey-<name>-<time>.json` (optional): the same data as raw JSON

## Shopify import
1. **Before importing**, create the metafield definition in Shopify admin:
   Settings → Custom data → Products → Add definition
   - Name: `Product Data`
   - Namespace and key: `custom.product_data` (it must match the value in the popup)
   - Type: **JSON**
2. Products → Import → upload the CSV (tick "Overwrite products with matching handles" if you are re-importing).

The column `Product Data (product.metafields.custom.product_data)` holds a JSON object with:
badges, suitable_for, rating (avg, count, histogram), helps, targets, offers/coupons,
in_vivo_spf (html and text, plus the report image), product_details, features, hero_ingredients,
full_ingredients, benefits, how_to_use (steps and pro_tip), faqs, more_info (manufacturer, MRP, expiry…),
clinical_results, external_ratings (Nykaa, Amazon, Flipkart), frequently_bought_together, routine,
gtin13, short_description, variant_images, source_url.

Notes:
- Inventory tracking is left blank, so variants import as untracked. Set stock after import if you need it.
- Compare-at price is only filled when it is higher than the price.
- Each product's JSON is about 15–20 KB, well under Shopify's JSON metafield limit.
