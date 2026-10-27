-- Rollback for 20261026030000_cart_contact (Stage 12.04). Contact-step details are lost; bags, orders and addresses are untouched.
DROP TABLE IF EXISTS "cart_contact";
