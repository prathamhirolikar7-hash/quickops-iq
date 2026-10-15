// =============================================================================
// QuickOps IQ · Synthetic seed configuration
// =============================================================================
// Everything here describes a FICTIONAL quick-commerce company. City names are
// real Indian cities. Store names, brands, riders, prices and every order are
// invented and labelled "(synthetic)" or prefixed "SYN-".
// =============================================================================

export const DEFAULTS = {
  seed: "quickops-iq-synthetic-v1",
  orders: 20_000,
  days: 90,
  endDate: "2026-10-13", // last full IST day included (inclusive)
}

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

// traffic: >1 means slower roads. basket: >1 means bigger baskets.
// rainBase: chance of a heavy-rain day during the monsoon months.
export const CITIES = [
  { code: "BLR", name: "Bengaluru", state: "Karnataka", traffic: 1.12, basket: 1.08, rainBase: 0.22 },
  { code: "MUM", name: "Mumbai", state: "Maharashtra", traffic: 1.16, basket: 1.1, rainBase: 0.4 },
  { code: "DEL", name: "Delhi NCR", state: "Delhi", traffic: 1.08, basket: 1.05, rainBase: 0.16 },
  { code: "HYD", name: "Hyderabad", state: "Telangana", traffic: 1.0, basket: 0.97, rainBase: 0.18 },
  { code: "PUN", name: "Pune", state: "Maharashtra", traffic: 0.96, basket: 0.95, rainBase: 0.26 },
]

// weight: relative demand. lat/lng: approximate locality centre.
export const STORES = [
  { code: "BLR-01", city: "BLR", locality: "Koramangala", weight: 1.25, lat: 12.9352, lng: 77.6245, opened: "2024-03-18" },
  { code: "BLR-02", city: "BLR", locality: "Indiranagar", weight: 1.15, lat: 12.9719, lng: 77.6412, opened: "2024-05-06" },
  { code: "BLR-03", city: "BLR", locality: "HSR Layout", weight: 1.05, lat: 12.9116, lng: 77.6474, opened: "2024-08-12" },
  { code: "BLR-04", city: "BLR", locality: "Whitefield", weight: 0.9, lat: 12.9698, lng: 77.75, opened: "2025-02-03" },
  { code: "MUM-01", city: "MUM", locality: "Andheri West", weight: 1.2, lat: 19.1364, lng: 72.8296, opened: "2024-02-26" },
  { code: "MUM-02", city: "MUM", locality: "Powai", weight: 1.05, lat: 19.1176, lng: 72.906, opened: "2024-06-10" },
  { code: "MUM-03", city: "MUM", locality: "Bandra West", weight: 1.15, lat: 19.0596, lng: 72.8295, opened: "2024-04-15" },
  { code: "MUM-04", city: "MUM", locality: "Lower Parel", weight: 0.95, lat: 18.9953, lng: 72.8302, opened: "2025-01-20" },
  { code: "DEL-01", city: "DEL", locality: "Gurugram Sector 29", weight: 1.1, lat: 28.4691, lng: 77.0652, opened: "2024-03-04" },
  { code: "DEL-02", city: "DEL", locality: "Saket", weight: 1.0, lat: 28.5245, lng: 77.2066, opened: "2024-07-22" },
  { code: "DEL-03", city: "DEL", locality: "Noida Sector 18", weight: 0.95, lat: 28.5708, lng: 77.3261, opened: "2024-11-11" },
  { code: "HYD-01", city: "HYD", locality: "Gachibowli", weight: 1.05, lat: 17.4401, lng: 78.3489, opened: "2024-04-01" },
  { code: "HYD-02", city: "HYD", locality: "Madhapur", weight: 1.0, lat: 17.4483, lng: 78.3915, opened: "2024-09-09" },
  { code: "HYD-03", city: "HYD", locality: "Kondapur", weight: 0.85, lat: 17.4698, lng: 78.3578, opened: "2025-03-17" },
  { code: "PUN-01", city: "PUN", locality: "Kothrud", weight: 0.9, lat: 18.5074, lng: 73.8077, opened: "2024-06-24" },
  { code: "PUN-02", city: "PUN", locality: "Baner", weight: 0.85, lat: 18.559, lng: 73.7868, opened: "2025-04-07" },
  // Planned store: exercises empty states, never receives orders or stock
  { code: "PUN-03", city: "PUN", locality: "Hinjewadi", weight: 0, lat: 18.5913, lng: 73.7389, opened: null, status: "planned" },
]

// Day-of-week demand (0 = Sunday)
export const DOW_FACTOR = [1.28, 0.92, 0.9, 0.93, 0.96, 1.05, 1.22]

// Synthetic festival / holiday uplifts (date in IST -> multiplier per city)
export const SPECIAL_DAYS = {
  "2026-08-15": { all: 1.2 }, // Independence Day
  "2026-09-14": { all: 1.1, MUM: 1.35, PUN: 1.3 }, // Ganesh Chaturthi
}

// Hour-of-day demand in IST: breakfast and evening peaks, store closed 02:00-05:59
export const HOUR_WEIGHTS = [
  0.012, 0.007, 0, 0, 0, 0, 0.016, 0.036, 0.056, 0.062, 0.052, 0.046,
  0.048, 0.044, 0.038, 0.036, 0.042, 0.054, 0.072, 0.086, 0.09, 0.08, 0.054, 0.032,
]
export const WEEKEND_HOUR_ADJUST = { 7: 0.75, 8: 0.85, 10: 1.2, 11: 1.25, 12: 1.15, 22: 1.2, 23: 1.25, 0: 1.3 }

// Traffic slowdown by IST hour (applied to rider speed)
export const PEAK_TRAFFIC = { 8: 1.15, 9: 1.25, 10: 1.15, 18: 1.2, 19: 1.3, 20: 1.25, 21: 1.1 }

export const PAYMENT_MIX = [
  ["upi", 0.62],
  ["card", 0.14],
  ["wallet", 0.08],
  ["cod", 0.16],
]

// Basket size (number of distinct products) before the city basket factor
export const LINES_DIST = [
  [1, 0.17], [2, 0.21], [3, 0.2], [4, 0.15], [5, 0.1], [6, 0.07], [7, 0.04], [8, 0.03], [9, 0.015], [10, 0.015],
]

// Non-stock cancellation plan (stage, reason, probability per order)
export const CANCEL_PLAN = [
  { stage: "placed", reason: "payment_failed", p: 0.009, prepaidOnly: true },
  { stage: "placed", reason: "customer_request", p: 0.009 },
  { stage: "confirmed", reason: "customer_request", p: 0.005 },
  { stage: "packed", reason: "store_closed", p: 0.0008 },
  { stage: "out_for_delivery", reason: "address_issue", p: 0.004 },
]

export const SLA_MINUTES = { default: 10 }

export const BRANDS = ["Desi Harvest", "Urban Pantry", "FreshNest", "GharSe", "Kitchen Kart", "Swachh Home", "Nanha Care", "Paws & Co"]

// Fresh categories expire / get top-ups twice a day
export const FRESH_CATEGORIES = new Set(["Fruits & Vegetables", "Dairy, Bread & Eggs", "Meat & Seafood"])

// [category, popularity weight, brand index, [subcategory, name, unit, mrp in ₹][]]
export const CATALOG = [
  ["Fruits & Vegetables", 22, 0, [
    ["Fresh Fruits", "Banana Robusta", "6 pcs", 48], ["Fresh Fruits", "Shimla Apple", "4 pcs", 160],
    ["Fresh Fruits", "Pomegranate", "2 pcs", 140], ["Fresh Fruits", "Papaya", "1 pc (approx. 1 kg)", 70],
    ["Fresh Fruits", "Guava", "500 g", 60], ["Fresh Fruits", "Nagpur Orange", "1 kg", 110],
    ["Fresh Vegetables", "Onion", "1 kg", 45], ["Fresh Vegetables", "Potato", "1 kg", 40],
    ["Fresh Vegetables", "Hybrid Tomato", "500 g", 30], ["Fresh Vegetables", "Coriander Bunch", "100 g", 15],
    ["Fresh Vegetables", "Green Chilli", "100 g", 12], ["Fresh Vegetables", "Ginger", "100 g", 25],
    ["Fresh Vegetables", "Garlic", "100 g", 30], ["Fresh Vegetables", "Cucumber", "500 g", 35],
    ["Fresh Vegetables", "Carrot", "500 g", 40], ["Fresh Vegetables", "Green Capsicum", "250 g", 30],
    ["Fresh Vegetables", "Lady Finger", "250 g", 28], ["Fresh Vegetables", "Spinach Bunch", "250 g", 25],
    ["Fresh Vegetables", "Lemon", "4 pcs", 24], ["Fresh Vegetables", "Cauliflower", "1 pc", 45],
  ]],
  ["Dairy, Bread & Eggs", 20, 0, [
    ["Milk", "Toned Milk", "500 ml", 28], ["Milk", "Full Cream Milk", "1 L", 68],
    ["Curd & Paneer", "Fresh Curd", "400 g", 40], ["Curd & Paneer", "Malai Paneer", "200 g", 90],
    ["Butter & Cheese", "Salted Butter", "100 g", 58], ["Butter & Cheese", "Cheese Slices", "200 g", 140],
    ["Bread & Pav", "Brown Bread", "400 g", 50], ["Bread & Pav", "White Bread", "400 g", 40],
    ["Bread & Pav", "Ladi Pav", "6 pcs", 35], ["Eggs", "Farm Eggs", "6 pcs", 54],
    ["Ghee", "Cow Ghee", "500 ml", 330], ["Dairy Drinks", "Masala Buttermilk", "200 ml", 15],
    ["Dairy Drinks", "Sweet Lassi", "200 ml", 25],
  ]],
  ["Atta, Rice, Dal & Oil", 10, 4, [
    ["Atta & Flours", "Whole Wheat Atta", "5 kg", 290], ["Rice", "Basmati Rice", "1 kg", 160],
    ["Rice", "Sona Masoori Rice", "5 kg", 420], ["Dals & Pulses", "Toor Dal", "1 kg", 170],
    ["Dals & Pulses", "Moong Dal", "500 g", 85], ["Dals & Pulses", "Chana Dal", "1 kg", 110],
    ["Edible Oils", "Sunflower Oil", "1 L", 165], ["Edible Oils", "Mustard Oil", "1 L", 185],
    ["Sugar & Salt", "Sugar", "1 kg", 50], ["Sugar & Salt", "Iodised Salt", "1 kg", 28],
    ["Atta & Flours", "Thick Poha", "500 g", 45], ["Atta & Flours", "Besan", "500 g", 70],
  ]],
  ["Masalas & Packaged Food", 9, 1, [
    ["Masalas", "Turmeric Powder", "100 g", 35], ["Masalas", "Red Chilli Powder", "100 g", 45],
    ["Masalas", "Garam Masala", "50 g", 55], ["Noodles & Pasta", "Instant Noodles", "4 x 70 g", 56],
    ["Noodles & Pasta", "Penne Pasta", "500 g", 95], ["Sauces & Spreads", "Tomato Ketchup", "500 g", 120],
    ["Sauces & Spreads", "Peanut Butter", "340 g", 199], ["Breakfast", "Rolled Oats", "1 kg", 199],
    ["Breakfast", "Cornflakes", "475 g", 180], ["Sauces & Spreads", "Mixed Fruit Jam", "500 g", 150],
    ["Ready to Eat", "Rajma Chawal", "300 g", 110],
  ]],
  ["Snacks & Beverages", 16, 1, [
    ["Chips & Namkeen", "Classic Salted Chips", "52 g", 20], ["Chips & Namkeen", "Masala Chips", "90 g", 30],
    ["Chips & Namkeen", "Aloo Bhujia", "400 g", 105], ["Chips & Namkeen", "Salted Peanuts", "200 g", 60],
    ["Biscuits", "Cream Biscuits", "120 g", 30], ["Biscuits", "Digestive Biscuits", "250 g", 60],
    ["Chocolates", "Dark Chocolate Bar", "80 g", 99], ["Chocolates", "Milk Chocolate", "50 g", 50],
    ["Soft Drinks", "Cola", "750 ml", 40], ["Soft Drinks", "Lemon Soda", "750 ml", 40],
    ["Juices", "Mango Drink", "600 ml", 42], ["Juices", "Orange Juice", "1 L", 130],
    ["Water", "Packaged Drinking Water", "1 L", 20], ["Juices", "Tender Coconut Water", "200 ml", 45],
    ["Tea & Coffee", "Masala Chai Tea", "250 g", 140], ["Tea & Coffee", "Instant Coffee", "100 g", 310],
    ["Energy Drinks", "Energy Drink", "250 ml", 125], ["Tea & Coffee", "Cold Coffee", "180 ml", 45],
  ]],
  ["Frozen & Ice Cream", 5, 2, [
    ["Frozen Veg", "Frozen Green Peas", "500 g", 95], ["Frozen Snacks", "Frozen French Fries", "420 g", 125],
    ["Frozen Snacks", "Veg Momos", "10 pcs", 150], ["Ice Cream", "Vanilla Ice Cream Tub", "700 ml", 220],
    ["Ice Cream", "Chocolate Cone", "120 ml", 60], ["Ice Cream", "Malai Kulfi", "4 pcs", 120],
  ]],
  ["Meat & Seafood", 4, 2, [
    ["Chicken", "Chicken Curry Cut", "500 g", 220], ["Chicken", "Boneless Chicken Breast", "450 g", 280],
    ["Fish", "Rohu Curry Cut", "500 g", 260], ["Mutton", "Mutton Curry Cut", "500 g", 450],
  ]],
  ["Personal Care", 6, 3, [
    ["Bath & Body", "Bath Soap", "4 x 100 g", 160], ["Hair Care", "Shampoo", "340 ml", 290],
    ["Oral Care", "Toothpaste", "150 g", 110], ["Oral Care", "Soft Toothbrush", "2 pcs", 80],
    ["Bath & Body", "Hand Wash Refill", "750 ml", 99], ["Skin Care", "Face Wash", "100 ml", 199],
    ["Feminine Hygiene", "Sanitary Pads", "20 pcs", 260], ["Shaving", "Shaving Foam", "200 g", 230],
  ]],
  ["Household & Cleaning", 6, 5, [
    ["Dishwash", "Dishwash Liquid", "500 ml", 110], ["Dishwash", "Dishwash Bar", "3 x 200 g", 60],
    ["Laundry", "Detergent Powder", "1 kg", 135], ["Laundry", "Liquid Detergent", "1 L", 230],
    ["Cleaners", "Floor Cleaner", "1 L", 199], ["Cleaners", "Toilet Cleaner", "500 ml", 99],
    ["Kitchen Essentials", "Garbage Bags (Medium)", "30 pcs", 99], ["Kitchen Essentials", "Kitchen Towels", "2 rolls", 140],
    ["Kitchen Essentials", "Aluminium Foil", "9 m", 120], ["Repellents", "Mosquito Repellent Refill", "45 ml", 85],
  ]],
  ["Baby Care", 2, 6, [
    ["Diapers", "Baby Diapers (M)", "20 pcs", 399], ["Wipes", "Baby Wipes", "72 pcs", 199],
    ["Skin Care", "Baby Lotion", "200 ml", 210],
  ]],
  ["Pet Care", 1, 7, [
    ["Dog Food", "Adult Dog Food", "1.2 kg", 360], ["Cat Food", "Cat Food Pouch", "85 g", 45],
  ]],
  ["Health & Wellness", 3, 3, [
    ["Hydration", "ORS Drink", "200 ml", 35], ["Hydration", "Glucose Powder", "500 g", 120],
    ["First Aid", "Antiseptic Liquid", "250 ml", 110], ["First Aid", "Adhesive Bandages", "20 pcs", 50],
    ["Hygiene", "Hand Sanitizer", "200 ml", 99],
  ]],
]

export const FIRST_NAMES = [
  "Aarav", "Vivaan", "Aditya", "Arjun", "Sai", "Rohan", "Karthik", "Imran", "Rahul", "Vikram", "Suresh", "Manoj",
  "Faizan", "Deepak", "Nikhil", "Pranav", "Harish", "Ganesh", "Anil", "Ravi", "Sanjay", "Mohit", "Yusuf", "Kiran",
  "Ajay", "Naveen", "Tarun", "Varun", "Amit", "Lokesh", "Priya", "Sneha", "Kavya", "Anjali", "Meera", "Pooja",
]
export const LAST_INITIALS = "ABCDGHJKMNPRSTVY".split("")
