from app.csv_export import safe_csv_cell


def test_spreadsheet_formula_prefixes_are_neutralized():
    for value in ("=1+1", "+cmd", "-2+3", "@SUM(A1:A2)", " \t=HYPERLINK('x')"):
        assert safe_csv_cell(value).startswith("'")


def test_normal_csv_values_are_unchanged():
    assert safe_csv_cell("project-name") == "project-name"
    assert safe_csv_cell(42) == 42
