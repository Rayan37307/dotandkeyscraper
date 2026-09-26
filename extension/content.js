(() => {
  if (window.__dkScraperLoaded) return;
  window.__dkScraperLoaded = true;

  const ORIGIN = location.origin;
  const REQUEST_DELAY_MS = 350;
  const CONCURRENCY = 2;

  let running = false;
  let stopRequested = false;

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const $ = (root, sel) => root.querySelector(sel);
  const $$ = (root, sel) => Array.from(root.querySelectorAll(sel));

  function abs(u) {
    if (!u) return '';
    u = u.trim();
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('/')) return ORIGIN + u;
    return u;
  }

  // Strip Shopify CDN resize/format params, keep the cache-busting ?v=
  function cleanImg(u) {
    u = abs(u);
    if (!u) return '';
    try {
      const x = new URL(u);
      const v = x.searchParams.get('v');
      x.search = '';
      if (v) x.searchParams.set('v', v);
      return x.toString();
    } catch {
      return u;
    }
  }

  function htmlText(el) {
    if (!el) return '';
    const c = el.cloneNode(true);
    $$(c, 'br').forEach((b) => b.replaceWith(' '));
    return txt(c);
  }

  function handleFromUrl(u) {
    const m = (u || '').match(/\/products\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  // Remove empty strings / arrays / objects recursively
  function compact(v) {
    if (Array.isArray(v)) {
      const a = v.map(compact).filter((x) => x !== undefined);
      return a.length ? a : undefined;
    }
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) {
        const c = compact(val);
        if (c !== undefined) o[k] = c;
      }
      return Object.keys(o).length ? o : undefined;
    }
    if (v === null || v === undefined || v === '') return undefined;
    return v;
  }

  async function fetchWithRetry(url, asJson, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(abs(url), { credentials: 'same-origin' });
        if (res.status === 429) {
          await sleep(2000 * (i + 1));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return asJson ? await res.json() : await res.text();
      } catch (e) {
        lastErr = e;
        await sleep(800 * (i + 1));
      }
    }
    throw lastErr || new Error('Request failed: ' + url);
  }

  // ---------- on-page progress panel ----------
  let panel, logEl, barEl;
  function ensurePanel() {
    if (panel && document.body.contains(panel)) return;
    panel = document.createElement('div');
    panel.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;background:#fff;' +
      'border:2px solid #ff4081;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);' +
      'font:12px/1.4 system-ui,sans-serif;color:#222;padding:10px;';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
      '<b style="color:#ff4081">Dot &amp; Key Scraper</b>' +
      '<span><button data-a="stop" style="border:0;background:#333;color:#fff;border-radius:4px;padding:3px 8px;cursor:pointer">Stop</button> ' +
      '<button data-a="close" style="border:0;background:#eee;border-radius:4px;padding:3px 8px;cursor:pointer">×</button></span></div>' +
      '<div style="height:6px;background:#eee;border-radius:3px;overflow:hidden;margin-bottom:6px"><div data-bar style="height:100%;width:0;background:#ff4081"></div></div>' +
      '<div data-log style="max-height:180px;overflow:auto;white-space:pre-wrap"></div>';
    document.body.appendChild(panel);
    logEl = $(panel, '[data-log]');
    barEl = $(panel, '[data-bar]');
    $(panel, '[data-a=stop]').onclick = () => {
      stopRequested = true;
      log('Stop requested — finishing current items and exporting what was scraped…');
    };
    $(panel, '[data-a=close]').onclick = () => panel.remove();
  }
  function log(msg) {
    ensurePanel();
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
  function progress(done, total) {
    ensurePanel();
    barEl.style.width = total ? Math.round((done / total) * 100) + '%' : '0';
  }

  // ---------- Shopify base product data ----------
  function fromProductJson(p) {
    const imgs = (p.images || []).map((im, i) => ({
      id: im.id,
      src: cleanImg(im.src),
      alt: im.alt || p.title,
      position: im.position || i + 1,
      variant_ids: im.variant_ids || [],
    }));
    const unitToG = { g: 1, kg: 1000, lb: 453.592, oz: 28.3495 };
    return {
      id: p.id,
      handle: p.handle,
      title: p.title,
      body_html: p.body_html || '',
      vendor: p.vendor || '',
      product_type: p.product_type || '',
      tags: typeof p.tags === 'string' ? p.tags.split(',').map((s) => s.trim()).filter(Boolean) : p.tags || [],
      options: (p.options || []).map((o) => ({ name: o.name, values: o.values || [] })),
      variants: (p.variants || []).map((v) => {
        const img = imgs.find((im) => im.id === v.image_id);
        let grams = v.grams;
        if (grams == null && v.weight != null) grams = Math.round(v.weight * (unitToG[v.weight_unit] || 1));
        return {
          id: v.id,
          title: v.title,
          option1: v.option1,
          option2: v.option2,
          option3: v.option3,
          sku: v.sku || '',
          price: v.price,
          compare_at_price: v.compare_at_price || '',
          grams: grams || 0,
          barcode: v.barcode || '',
          requires_shipping: v.requires_shipping !== false,
          taxable: v.taxable !== false,
          available: v.available,
          image: img ? img.src : '',
        };
      }),
      images: imgs,
    };
  }

  function fromProductJs(p) {
    const money = (c) => (c == null || c === '' ? '' : (Number(c) / 100).toFixed(2));
    return {
      id: p.id,
      handle: p.handle,
      title: p.title,
      body_html: p.description || '',
      vendor: p.vendor || '',
      product_type: p.type || '',
      tags: p.tags || [],
      options: (p.options || []).map((o) =>
        typeof o === 'string' ? { name: o, values: [] } : { name: o.name, values: o.values || [] }
      ),
      variants: (p.variants || []).map((v) => ({
        id: v.id,
        title: v.title,
        option1: v.option1,
        option2: v.option2,
        option3: v.option3,
        sku: v.sku || '',
        price: money(v.price),
        compare_at_price: money(v.compare_at_price),
        grams: v.weight || 0,
        barcode: v.barcode || '',
        requires_shipping: v.requires_shipping !== false,
        taxable: v.taxable !== false,
        available: v.available,
        image: v.featured_image ? cleanImg(v.featured_image.src) : '',
      })),
      images: (p.images || []).map((src, i) => ({
        src: cleanImg(src),
        alt: (p.media && p.media[i] && p.media[i].alt) || p.title,
        position: i + 1,
        variant_ids: [],
      })),
    };
  }

  async function getBaseProduct(handle) {
    try {
      const j = await fetchWithRetry(`/products/${handle}.json`, true);
      if (j && j.product) return fromProductJson(j.product);
    } catch (e) {
      /* fall through to .js */
    }
    const js = await fetchWithRetry(`/products/${handle}.js`, true);
    return fromProductJs(js);
  }

  // ---------- PDP HTML extraction (everything beyond the basic Shopify fields) ----------
  function parseLdJson(doc) {
    const out = { product: null, faq: null };
    for (const s of $$(doc, 'script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const it of items) {
          if (it['@type'] === 'Product') out.product = it;
          if (it['@type'] === 'FAQPage') out.faq = it;
        }
      } catch {
        /* some themes emit invalid ld+json — ignore */
      }
    }
    return out;
  }

  function parseJsonScript(doc, sel) {
    const s = $(doc, sel);
    if (!s) return null;
    try {
      return JSON.parse(s.textContent);
    } catch {
      return null;
    }
  }

  function extractDetails(doc, handle, base) {
    const ld = parseLdJson(doc);
    const lp = ld.product || {};

    // Rating + histogram
    const histogram = $$(doc, '.jdgm-histogram__row[data-rating]')
      .filter((r) => r.dataset.rating && r.dataset.rating !== 'null')
      .map((r) => ({
        stars: Number(r.dataset.rating),
        count: Number(r.dataset.frequency || 0),
        percent: Number(r.dataset.percentage || 0),
      }));
    const widget = $(doc, '.jdgm-rev-widg');
    const rating = {
      average: lp.aggregateRating ? Number(lp.aggregateRating.ratingValue) : widget ? Number(widget.dataset.averageRating) : undefined,
      count: lp.aggregateRating ? Number(lp.aggregateRating.reviewCount) : widget ? Number(widget.dataset.numberOfReviews) : undefined,
      display_text: txt($(doc, '.main-pdp-rating__count')),
      histogram,
    };

    // Helps / targets
    const helps = $$(doc, '[data-pdp-ht-card]').map((c) => ({
      title: c.dataset.title || txt($(c, 'span')),
      description: c.dataset.description || '',
      icon: cleanImg($(c, 'img') && $(c, 'img').getAttribute('src')),
    }));
    const targets = $$(doc, '.pdp-ht-chip').map(txt);

    // Offers (same list per variant on this theme — keep first, plus coupon codes)
    const offersByVariant = parseJsonScript(doc, 'script[data-pdp-offers-by-variant]');
    const offers = offersByVariant ? Object.values(offersByVariant)[0] || [] : [];

    // In-vivo SPF block
    const vivoText = $(doc, '.collapsable-in-vivo-spf__text');
    const vivoImg = $(doc, '[data-vivo-preview]');
    const inVivo = vivoText
      ? {
          heading: txt($(doc, '.collapsable-in-vivo-spf__heading')),
          html: ($(vivoText, '.metafield-rich_text_field') || vivoText).innerHTML.trim(),
          text: htmlText(vivoText),
          report_image: vivoImg ? cleanImg(vivoImg.dataset.fullSrc) : '',
        }
      : null;

    // Product details icons list
    const productDetails = $$(doc, '#pdp-anchor-details .new-details-collapsable__item, .new-details-collapsable__item').map((li) => ({
      label: txt($(li, '.new-details-collapsable__item-text')),
      icon: cleanImg($(li, 'img') && $(li, 'img').getAttribute('src')),
    }));
    // dedupe (mobile + desktop sections can repeat)
    const seenDetail = new Set();
    const productDetailsUnique = productDetails.filter((d) => d.label && !seenDetail.has(d.label) && seenDetail.add(d.label));

    // Hero ingredients
    const heroIngredients = $$(doc, '.collapsable-hero-ingr__card').map((c) => ({
      name: txt($(c, '.collapsable-hero-ingr__card-title')),
      description: txt($(c, '.collapsable-hero-ingr__card-desc')),
      image: cleanImg($(c, 'img') && $(c, 'img').getAttribute('src')),
    }));

    // Full ingredient list (strip the disclaimer div)
    let fullIngredients = '';
    let ingredientsDisclaimer = '';
    const fib = $(doc, '.collapsable-hero-ingr__full-ingr-body');
    if (fib) {
      const c = fib.cloneNode(true);
      const disc = $(c, 'div');
      if (disc) {
        ingredientsDisclaimer = txt(disc);
        disc.remove();
      }
      fullIngredients = txt(c);
    }

    const benefits = $$(doc, '.pdp-benefit-collapsable__benefit-list li').map(txt);
    const howToSteps = $$(doc, '.pdp-howto-collapsable__steps-list li').map(txt);
    const proTip = txt($(doc, '.pdp-howto-collapsable__pro-tip')).replace(/^PRO TIP:\s*/i, '');

    // FAQs (DOM first, ld+json fallback)
    let faqs = $$(doc, '.collapsable-faq__item').map((li) => ({
      question: txt($(li, '.collapsable-faq__question')),
      answer: txt($(li, '.collapsable-faq__answer')),
    }));
    if (!faqs.length && ld.faq && Array.isArray(ld.faq.mainEntity)) {
      faqs = ld.faq.mainEntity.map((q) => ({
        question: (q.name || '').trim(),
        answer: ((q.acceptedAnswer && q.acceptedAnswer.text) || '').trim(),
      }));
    }

    // More information (label: value)
    const moreInfo = {};
    for (const li of $$(doc, '.collapsable-moreinfo__item')) {
      const b = $(li, 'b');
      const label = txt(b).replace(/:\s*$/, '');
      const c = li.cloneNode(true);
      const cb = $(c, 'b');
      if (cb) cb.remove();
      const value = txt(c);
      if (label) moreInfo[label] = value;
    }

    // Clinical / self-assessment results
    const clinical = {
      title: txt($(doc, '.pdp-transformation__results-title')),
      stats: $$(doc, '.pdp-transformation__stat').map((s) => ({
        value: txt($(s, '.pdp-transformation__percentage')),
        description: txt($(s, '.pdp-transformation__description')),
      })),
      result: txt($(doc, '.pdp-transformation__result-highlight')),
      footnote: txt($(doc, '.pdp-transformation__footnote')),
    };

    const features = $$(doc, '.pdp-feature-svg__label').map(htmlText);

    const externalRatings = $$(doc, '.pdp-social-reviews__card').map((c) => {
      const line = txt($(c, '.pdp-social-reviews__rating-line'));
      const m = line.match(/([\d.]+)\s*\(([^)]+)\)/);
      return {
        platform: (($(c, 'img') && $(c, 'img').getAttribute('alt')) || '').replace(/\s*Rating$/i, ''),
        rating: m ? Number(m[1]) : line,
        ratings_count: m ? m[2] : '',
        reviews: txt($(c, '.pdp-social-reviews__label-line')),
      };
    });

    const boughtTogether = $$(doc, '[data-customers-also-bought-item]')
      .filter((a) => a.dataset.isCurrentProduct !== 'true')
      .map((a) => {
        const link = $(a, '.customers-also-bought__title');
        const t = link ? link.cloneNode(true) : null;
        if (t) $$(t, '[data-variant-title]').forEach((s) => s.remove());
        return {
          handle: handleFromUrl(link && link.getAttribute('href')),
          title: txt(t),
          product_id: a.dataset.productId,
          variant_id: a.dataset.variantId,
          product_type: a.dataset.productType,
        };
      });

    const routine = {
      title: txt($(doc, '.skincare-popup .popup-title')),
      steps: $$(doc, '.popup-product-card[data-popup-item]').map((c) => ({
        step: txt($(c, '.step')),
        title: txt($(c, '.info p')),
        product_id: c.dataset.productId,
        variant_id: c.dataset.variantId,
        product_type: c.dataset.productType,
        is_current_product: c.dataset.isCurrentProduct === 'true' || undefined,
      })),
    };

    // Variant extras from the theme's variant JSON
    const vdata = parseJsonScript(doc, 'script[data-variant-data]');
    const stickyImgs = parseJsonScript(doc, 'script[data-sticky-variant-images]') || {};

    const scrollTabs = $$(doc, '[data-tab-btn]').map(txt);

    const metaDesc = $(doc, 'meta[name="description"]');

    return {
      source_url: `${ORIGIN}/products/${handle}`,
      scraped_at: new Date().toISOString(),
      product_id: base.id,
      short_description: lp.description || (metaDesc && metaDesc.getAttribute('content')) || '',
      gtin13: lp.gtin13 || '',
      sku: lp.sku || '',
      brand: (lp.brand && lp.brand.name) || base.vendor,
      badges: $$(doc, '.main-pdp-featured-tag__badge').map(txt),
      suitable_for: txt($(doc, '.main-pdp-skin-type__value')),
      rating,
      helps,
      targets,
      offers,
      in_vivo_spf: inVivo,
      product_details: productDetailsUnique,
      features,
      hero_ingredients: heroIngredients,
      full_ingredients: fullIngredients,
      ingredients_disclaimer: ingredientsDisclaimer,
      benefits,
      how_to_use: { steps: howToSteps, pro_tip: proTip },
      faqs,
      more_info: moreInfo,
      clinical_results: clinical,
      external_ratings: externalRatings,
      frequently_bought_together: boughtTogether,
      routine,
      variant_options: vdata ? vdata.options : undefined,
      variant_images: stickyImgs && Object.keys(stickyImgs).length
        ? Object.fromEntries(Object.entries(stickyImgs).map(([k, v]) => [k, cleanImg(v)]))
        : undefined,
      page_sections: scrollTabs,
    };
  }

  function buildBodyHtml(base, extra) {
    if (base.body_html && base.body_html.replace(/<[^>]*>/g, '').trim()) return base.body_html;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let h = '';
    if (extra.short_description) h += `<p>${esc(extra.short_description)}</p>`;
    if (extra.benefits && extra.benefits.length) h += `<h3>Benefits</h3><ul>${extra.benefits.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`;
    if (extra.hero_ingredients && extra.hero_ingredients.length)
      h += `<h3>Hero Ingredients</h3><ul>${extra.hero_ingredients.map((i) => `<li><strong>${esc(i.name)}</strong> – ${esc(i.description)}</li>`).join('')}</ul>`;
    const steps = extra.how_to_use && extra.how_to_use.steps;
    if (steps && steps.length) h += `<h3>How To Use</h3><ol>${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
    return h;
  }

  async function scrapeProduct(handle) {
    const [base, html] = await Promise.all([getBaseProduct(handle), fetchWithRetry(`/products/${handle}`, false)]);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const extra = compact(extractDetails(doc, handle, base)) || {};
    return { base, extra, body_html: buildBodyHtml(base, extra) };
  }

  // ---------- collection listing ----------
  async function getCollectionHandles(collection, max) {
    const handles = [];
    for (let page = 1; page < 100; page++) {
      if (stopRequested) break;
      let data;
      try {
        data = await fetchWithRetry(`/collections/${collection}/products.json?limit=250&page=${page}`, true);
      } catch (e) {
        log(`products.json failed (${e.message}) — falling back to links on this page.`);
        break;
      }
      const ps = (data && data.products) || [];
      if (!ps.length) break;
      for (const p of ps) if (!handles.includes(p.handle)) handles.push(p.handle);
      log(`Listing page ${page}: +${ps.length} (total ${handles.length})`);
      if (max && handles.length >= max) break;
      await sleep(REQUEST_DELAY_MS);
    }
    if (!handles.length) {
      // DOM fallback: product cards currently rendered on the page
      for (const a of $$(document, '.product-block a[href*="/products/"], .st-product a[href*="/products/"], a.st-title')) {
        const h = handleFromUrl(a.getAttribute('href'));
        if (h && !handles.includes(h)) handles.push(h);
      }
    }
    return max ? handles.slice(0, max) : handles;
  }

  // ---------- CSV ----------
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv(items, metaKey) {
    const metaHeader = `Product Data (product.metafields.${metaKey})`;
    const cols = [
      'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Product Category', 'Type', 'Tags', 'Published',
      'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value',
      'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker', 'Variant Inventory Qty',
      'Variant Inventory Policy', 'Variant Fulfillment Service', 'Variant Price', 'Variant Compare At Price',
      'Variant Requires Shipping', 'Variant Taxable', 'Variant Barcode',
      'Image Src', 'Image Position', 'Image Alt Text', 'Gift Card', 'SEO Title', 'SEO Description',
      'Variant Image', 'Variant Weight Unit', 'Status', metaHeader,
    ];
    const lines = [cols.map(csvCell).join(',')];

    for (const { base, extra, body_html } of items) {
      const variants = base.variants.length ? base.variants : [{}];
      const images = base.images;
      const opts = base.options;
      const n = Math.max(variants.length, images.length, 1);
      const barcodeFallback = variants.length === 1 ? extra.gtin13 || '' : '';

      for (let i = 0; i < n; i++) {
        const r = Object.fromEntries(cols.map((c) => [c, '']));
        r['Handle'] = base.handle;

        if (i === 0) {
          r['Title'] = base.title;
          r['Body (HTML)'] = body_html;
          r['Vendor'] = base.vendor;
          r['Type'] = base.product_type;
          r['Tags'] = base.tags.join(', ');
          r['Published'] = 'TRUE';
          r['Gift Card'] = 'FALSE';
          r['SEO Title'] = base.title;
          r['SEO Description'] = extra.short_description || '';
          r['Status'] = 'active';
          r[metaHeader] = JSON.stringify(extra);
          opts.forEach((o, idx) => { if (idx < 3) r[`Option${idx + 1} Name`] = o.name; });
          if (!opts.length) r['Option1 Name'] = 'Title';
        }

        if (i < variants.length && variants[i].id !== undefined) {
          const v = variants[i];
          r['Option1 Value'] = v.option1 || (opts.length ? '' : 'Default Title');
          r['Option2 Value'] = v.option2 || '';
          r['Option3 Value'] = v.option3 || '';
          r['Variant SKU'] = v.sku;
          r['Variant Grams'] = v.grams || 0;
          r['Variant Inventory Policy'] = 'deny';
          r['Variant Fulfillment Service'] = 'manual';
          r['Variant Price'] = v.price;
          const cmp = parseFloat(v.compare_at_price);
          r['Variant Compare At Price'] = cmp && cmp > parseFloat(v.price) ? v.compare_at_price : '';
          r['Variant Requires Shipping'] = v.requires_shipping ? 'TRUE' : 'FALSE';
          r['Variant Taxable'] = v.taxable ? 'TRUE' : 'FALSE';
          r['Variant Barcode'] = v.barcode || barcodeFallback;
          r['Variant Weight Unit'] = 'g';
          const vImg = v.image || (images.find((im) => (im.variant_ids || []).includes(v.id)) || {}).src ||
            (extra.variant_images && extra.variant_images[v.id]) || '';
          r['Variant Image'] = vImg;
        }

        if (i < images.length) {
          r['Image Src'] = images[i].src;
          r['Image Position'] = i + 1;
          r['Image Alt Text'] = images[i].alt || '';
        }

        lines.push(cols.map((c) => csvCell(r[c])).join(','));
      }
    }
    return lines.join('\r\n');
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------- main ----------
  async function run(config) {
    if (running) {
      log('Already running.');
      return;
    }
    running = true;
    stopRequested = false;
    ensurePanel();
    logEl.textContent = '';
    progress(0, 1);

    try {
      let handles;
      if (config.mode === 'product') {
        handles = [handleFromUrl(location.pathname)];
      } else {
        log(`Fetching product list for collection "${config.collection}"…`);
        handles = await getCollectionHandles(config.collection, config.max);
      }
      handles = handles.filter(Boolean);
      if (!handles.length) {
        log('No products found.');
        return;
      }
      log(`Scraping ${handles.length} product(s)…`);

      const results = new Array(handles.length);
      const failed = [];
      let next = 0;
      let done = 0;

      async function worker() {
        while (!stopRequested) {
          const i = next++;
          if (i >= handles.length) return;
          const h = handles[i];
          try {
            results[i] = await scrapeProduct(h);
            log(`✓ ${results[i].base.title}`);
          } catch (e) {
            failed.push(h);
            log(`✗ ${h}: ${e.message}`);
          }
          done++;
          progress(done, handles.length);
          await sleep(REQUEST_DELAY_MS);
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, handles.length) }, worker));

      const items = results.filter(Boolean);
      if (!items.length) {
        log('Nothing scraped.');
        return;
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const name = config.mode === 'product' ? handles[0].slice(0, 60) : config.collection;
      download(`dotandkey-${name}-${stamp}.csv`, buildCsv(items, config.metaKey), 'text/csv;charset=utf-8');
      if (config.json) {
        const raw = items.map((it) => ({ ...it.base, body_html: it.body_html, metafield: { key: config.metaKey, type: 'json', value: it.extra } }));
        download(`dotandkey-${name}-${stamp}.json`, JSON.stringify(raw, null, 2), 'application/json');
      }
      log(`Done: ${items.length} product(s) exported${failed.length ? `, ${failed.length} failed: ${failed.join(', ')}` : ''}.`);
    } catch (e) {
      log('Error: ' + e.message);
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.cmd === 'dk-scrape') {
      run(msg.config);
      sendResponse({ ok: true });
    }
  });
})();
