const inventoryCategories = [
    {
      categoryId: "cat_001",
      categoryName: "Electronics",
      description: "Gadgets, computer peripherals, and electronic accessories",
      items: [
        {
          itemId: "item_101",
          name: "Wireless Ergonomic Mouse",
          sku: "ELEC-MS-001",
          quantity: 45,
          price: 29.99,
          minThreshold: 10,
          supplier: "TechCorp Global",
          lastUpdated: "2026-10-28"
        },
        {
          itemId: "item_102",
          name: "Mechanical Gaming Keyboard",
          sku: "ELEC-KB-002",
          quantity: 8,
          price: 89.99,
          minThreshold: 15, // Below threshold (triggers low-stock alert)
          supplier: "KeyPro Industries",
          lastUpdated: "2026-10-30"
        },
        {
          itemId: "item_103",
          name: "USB-C Hub 7-in-1",
          sku: "ELEC-HUB-003",
          quantity: 62,
          price: 45.50,
          minThreshold: 20,
          supplier: "Connectify Ltd.",
          lastUpdated: "2026-10-25"
        }
      ]
    },
    {
      categoryId: "cat_002",
      categoryName: "Office Supplies",
      description: "Daily stationery, paper goods, and desk organization",
      items: [
        {
          itemId: "item_201",
          name: "Premium Copy Paper (A4, 500 Sheets)",
          sku: "OFF-PAP-101",
          quantity: 120,
          price: 7.99,
          minThreshold: 30,
          supplier: "PaperMill Co.",
          lastUpdated: "2026-10-29"
        },
        {
          itemId: "item_202",
          name: "Retractable Ballpoint Pens (Black, 12pk)",
          sku: "OFF-PEN-102",
          quantity: 5,
          price: 4.99,
          minThreshold: 10, // Below threshold
          supplier: "Stationery Direct",
          lastUpdated: "2026-10-20"
        },
        {
          itemId: "item_203",
          name: "Heavy-Duty Stapler",
          sku: "OFF-STP-103",
          quantity: 18,
          price: 14.25,
          minThreshold: 5,
          supplier: "OfficeEase",
          lastUpdated: "2026-10-22"
        }
      ]
    },
    {
      categoryId: "cat_003",
      categoryName: "Warehouse & Safety",
      description: "Protective gear, packaging, and handling equipment",
      items: [
        {
          itemId: "item_301",
          name: "Industrial Packing Tape (6-Roll Pack)",
          sku: "WH-TAP-301",
          quantity: 85,
          price: 18.00,
          minThreshold: 25,
          supplier: "PackSafe Solutions",
          lastUpdated: "2026-10-27"
        },
        {
          itemId: "item_302",
          name: "High-Visibility Safety Vest",
          sku: "WH-VET-302",
          quantity: 34,
          price: 12.50,
          minThreshold: 10,
          supplier: "SafeWork Gear",
          lastUpdated: "2026-10-15"
        }
      ]
    }
  ];
  
  // Export for use in Node.js or modern ES6 modules
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { inventoryCategories };
  }