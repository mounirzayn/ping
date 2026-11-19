// Catalogue Ping : catégories organisées comme Leboncoin (numéros vérifiés sur leboncoin.fr)
// et sites adaptés à chaque univers. Partagé entre l'appli et l'espace web.
(function () {
  // sites = sites surveillés automatiquement (cochés par défaut : ceux en premier, jusqu'à "defaults")
  // links = sites spécialisés : on y fait sa recherche, puis "Surveiller cette page"
  const GROUPS = [
    {
      id: 'vehicules', label: 'Véhicules', city: true,
      sites: ['lbc', 'fb', 'ebay'], defaults: ['lbc', 'fb'],
      links: [['La Centrale', 'https://www.lacentrale.fr'], ['AutoScout24', 'https://www.autoscout24.fr'], ['ParuVendu', 'https://www.paruvendu.fr']],
      cats: [['voitures', 'Voitures', 2], ['motos', 'Motos', 3], ['caravaning', 'Caravaning', 4], ['utilitaires', 'Utilitaires', 5],
        ['equip_auto', 'Équipement auto', 6], ['equip_moto', 'Équipement moto', 44], ['nautisme', 'Nautisme', 7]],
    },
    {
      id: 'immobilier', label: 'Immobilier', city: true, cityRequired: true,
      sites: ['lbc', 'fb'], defaults: ['lbc', 'fb'],
      links: [['SeLoger', 'https://www.seloger.com'], ['PAP', 'https://www.pap.fr'], ["Bien'ici", 'https://www.bienici.com']],
      cats: [['immo_vente', 'Ventes immobilières', 9], ['immo_location', 'Locations', 10], ['colocation', 'Colocations', 11],
        ['saisonnier', 'Locations saisonnières', 12], ['bureaux', 'Bureaux & commerces', 13]],
    },
    {
      id: 'multimedia', label: 'Multimédia', strict: true,
      sites: ['lbc', 'fb', 'vinted', 'ebay'], defaults: ['lbc', 'fb', 'vinted'],
      links: [['ParuVendu', 'https://www.paruvendu.fr'], ['Easy Cash', 'https://bons-plans.easycash.fr'], ['Cash Express', 'https://www.cashexpress.fr'], ['Back Market', 'https://www.backmarket.fr'], ['Rakuten', 'https://fr.shopping.rakuten.com']],
      cats: [['consoles', 'Consoles', 43], ['telephones', 'Téléphones & objets connectés', 17], ['informatique', 'Ordinateurs', 15],
        ['image_son', 'Photo, audio & vidéo', 16]],
    },
    {
      id: 'maison', label: 'Maison & jardin',
      sites: ['lbc', 'fb', 'vinted', 'ebay'], defaults: ['lbc', 'fb'],
      links: [['ParuVendu', 'https://www.paruvendu.fr'], ['Easy Cash', 'https://bons-plans.easycash.fr'], ['Cash Express', 'https://www.cashexpress.fr'], ['Selency', 'https://www.selency.fr']],
      cats: [['mobilier', 'Ameublement', 19], ['electromenager', 'Électroménager', 20], ['decoration', 'Décoration', 39],
        ['bricolage', 'Bricolage', 21], ['jardinage', 'Jardinage', 52], ['arts_table', 'Arts de la table', 45]],
    },
    {
      id: 'mode', label: 'Mode',
      sites: ['vinted', 'lbc', 'fb', 'ebay'], defaults: ['vinted', 'lbc'],
      links: [['Vestiaire Collective', 'https://fr.vestiairecollective.com']],
      cats: [['vetements', 'Vêtements', 22], ['chaussures', 'Chaussures', 53], ['accessoires_mode', 'Accessoires & bagagerie', 47],
        ['montres', 'Montres & bijoux', 42]],
    },
    {
      id: 'loisirs', label: 'Loisirs',
      sites: ['lbc', 'fb', 'vinted', 'ebay'], defaults: ['lbc', 'fb', 'vinted'],
      links: [['ParuVendu', 'https://www.paruvendu.fr'], ['Easy Cash', 'https://bons-plans.easycash.fr'], ['Cash Express', 'https://www.cashexpress.fr'], ['Rakuten', 'https://fr.shopping.rakuten.com']],
      cats: [['jeux_jouets', 'Jeux & jouets', 41], ['sport', 'Sport & plein air', 29], ['velos', 'Vélos', 55], ['instruments', 'Instruments de musique', 30],
        ['collection', 'Collection', 40], ['livres', 'Livres', 27], ['dvd', 'DVD & films', 25], ['cd', 'CD & vinyles', 26]],
    },
    {
      id: 'famille', label: 'Famille',
      sites: ['lbc', 'vinted', 'fb'], defaults: ['lbc', 'vinted'],
      links: [],
      cats: [['bebe', 'Équipement bébé', 23], ['vetements_bebe', 'Vêtements bébé', 54]],
    },
    {
      id: 'autres', label: 'Autres',
      sites: ['lbc', 'fb', 'vinted', 'ebay'], defaults: ['lbc', 'fb'],
      links: [],
      cats: [['tout', 'Toutes catégories', null], ['animaux', 'Animaux', 28], ['autres_objets', 'Autres', 38]],
    },
  ];
  const SITE_NAMES = { lbc: 'Leboncoin', fb: 'Marketplace', vinted: 'Vinted', ebay: 'eBay' };

  // Index à plat : clé → { label, lbc, group }
  const CATS = {};
  for (const g of GROUPS) for (const [k, label, lbc] of g.cats) CATS[k] = { label, lbc, group: g };
  const groupOf = (k) => (CATS[k] || CATS.tout).group;

  function buildUrl(site, q, catKey, min, max, city) {
    const cat = CATS[catKey] || CATS.tout;
    const g = cat.group.id;
    const query = q || (catKey !== 'tout' ? cat.label : '');
    let u;
    if (site === 'lbc') {
      u = new URL('https://www.leboncoin.fr/recherche');
      if (cat.lbc) u.searchParams.set('category', cat.lbc);
      if (q) u.searchParams.set('text', q);
      if (city) u.searchParams.set('locations', city);
      if (min || max) u.searchParams.set('price', `${min || 'min'}-${max || 'max'}`);
      u.searchParams.set('sort', 'time'); u.searchParams.set('order', 'desc');
    } else if (site === 'fb') {
      // Ville dans le chemin : sinon Facebook prend la position du compte (parfois à l'étranger)
      const path = g === 'vehicules' ? 'vehicles' : catKey === 'immo_location' || catKey === 'colocation' ? 'propertyrentals' : catKey === 'immo_vente' ? 'propertyforsale' : 'search/';
      u = new URL('https://www.facebook.com/marketplace/paris/' + path);
      if (q || path === 'search/') u.searchParams.set('query', query);
      u.searchParams.set('sortBy', 'creation_time_descend');
      if (min) u.searchParams.set('minPrice', min); if (max) u.searchParams.set('maxPrice', max);
    } else if (site === 'vinted') {
      u = new URL('https://www.vinted.fr/catalog');
      u.searchParams.set('search_text', query); u.searchParams.set('order', 'newest_first');
      if (min) u.searchParams.set('price_from', min); if (max) u.searchParams.set('price_to', max);
    } else {
      u = new URL('https://www.ebay.fr/sch/i.html');
      u.searchParams.set('_nkw', query); u.searchParams.set('_sop', '10');
      if (min) u.searchParams.set('_udlo', min); if (max) u.searchParams.set('_udhi', max);
    }
    return u.toString();
  }

  // Remplit un <select> avec des groupes comme Leboncoin
  function fillSelect(sel, current) {
    sel.innerHTML = GROUPS.map((g) => `<optgroup label="${g.label}">${g.cats.map(([k, l]) => `<option value="${k}"${k === current ? ' selected' : ''}>${l}</option>`).join('')}</optgroup>`).join('');
  }

  window.PING_CATALOG = { GROUPS, CATS, SITE_NAMES, groupOf, buildUrl, fillSelect };
})();
