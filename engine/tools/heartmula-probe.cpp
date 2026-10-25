// CPU tokenizer bring-up. Other HeartMuLa component probes can add modes here.
#include "heartmula/tokenizer.h"

#include <iostream>
#include <memory>

using JsonDoc = std::unique_ptr<yyjson_doc, decltype(&yyjson_doc_free)>;

static std::vector<int32_t> tokenize(const HeartMuLaTokenizer & t, yyjson_val * root) {
    const auto * text = yyjson_obj_get(root, "text");
    if (!yyjson_is_str(text)) { throw std::runtime_error("text must be a string"); }
    const auto * mode_value = yyjson_obj_get(root, "mode");
    if (mode_value && !yyjson_is_str(mode_value)) { throw std::runtime_error("mode must be a string"); }
    const std::string mode = mode_value ? yyjson_get_str(mode_value) : "raw";
    const std::string input(yyjson_get_str(text), yyjson_get_len(text));
    const auto * add = yyjson_obj_get(root, "add_special_tokens");
    if (add && !yyjson_is_bool(add)) { throw std::runtime_error("add_special_tokens must be a bool"); }
    if (mode == "raw") { return heartmula_tokenizer_encode(t, input, !add || yyjson_get_bool(add)); }
    if (mode == "tags" || mode == "lyrics") {
        if (add && !yyjson_get_bool(add)) { throw std::runtime_error("prompt modes always add BOS/EOS"); }
        return heartmula_tokenizer_prompt(t, input, mode == "tags");
    }
    throw std::runtime_error("mode must be raw, tags or lyrics");
}

static void print_ids(const std::vector<int32_t> & ids) {
    std::cout << "{\"ids\":[";
    for (size_t i = 0; i < ids.size(); ++i) { if (i) { std::cout << ','; } std::cout << ids[i]; }
    std::cout << "]}\n";
}

int main(int argc, char ** argv) {
    try {
        std::string path, mode = "raw", text, fixtures;
        bool stdin_mode = false, have_text = false, action = false, add_bos = true;
        for (int i = 1; i < argc; ++i) {
            const std::string arg = argv[i];
            const auto value = [&]() -> std::string {
                if (++i >= argc) { throw std::runtime_error("missing value for " + arg); }
                return argv[i];
            };
            if (arg == "--tokenizer") { path = value(); }
            else if (arg == "--tokenize") { action = true; }
            else if (arg == "--mode") { mode = value(); }
            else if (arg == "--text") { text = value(); have_text = true; }
            else if (arg == "--stdin") { stdin_mode = true; }
            else if (arg == "--no-special-tokens") { add_bos = false; }
            else if (arg == "--tokenizer-check") { fixtures = value(); action = true; }
            else if (arg == "--help") {
                std::cout << "heartmula-probe --tokenize --tokenizer FILE "
                             "[--mode raw|tags|lyrics --text TEXT [--no-special-tokens] | --stdin]\n"
                             "heartmula-probe --tokenizer FILE --tokenizer-check CASES.json\n"
                             "--stdin reads JSON lines with text, mode and add_special_tokens.\n";
                return 0;
            } else { throw std::runtime_error("unknown option: " + arg); }
        }
        if (!action || path.empty() || (stdin_mode && have_text) ||
            (!fixtures.empty() && (stdin_mode || have_text))) {
            throw std::runtime_error("invalid options; use --help");
        }
        HeartMuLaTokenizer t;
        std::string error;
        if (!heartmula_tokenizer_load(&t, path.c_str(), &error)) { throw std::runtime_error(error); }
        if (!fixtures.empty()) {
            JsonDoc doc(yyjson_read_file(fixtures.c_str(), 0, nullptr, nullptr), yyjson_doc_free);
            if (!doc) { throw std::runtime_error("cannot read fixture JSON"); }
            auto * cases = yyjson_obj_get(yyjson_doc_get_root(doc.get()), "cases");
            if (!yyjson_is_arr(cases) || !yyjson_arr_size(cases)) { throw std::runtime_error("empty fixture cases"); }
            size_t index, count, mismatches = 0;
            yyjson_val * row;
            yyjson_arr_foreach(cases, index, count, row) {
                const auto ids = tokenize(t, row);
                auto * expected = yyjson_obj_get(row, "ids");
                bool match = yyjson_is_arr(expected) && yyjson_arr_size(expected) == ids.size();
                for (size_t j = 0; match && j < ids.size(); ++j) {
                    auto * id = yyjson_arr_get(expected, j);
                    match = yyjson_is_int(id) && yyjson_get_int(id) == ids[j];
                }
                if (!match) { ++mismatches; std::cerr << "mismatch at case " << index << '\n'; }
            }
            std::cout << "TOKENIZER FIXTURES: " << (mismatches ? "FAIL" : "PASS")
                      << "; cases=" << yyjson_arr_size(cases) << "; mismatches=" << mismatches << '\n';
            return mismatches ? 1 : 0;
        }
        if (stdin_mode) {
            std::string line;
            while (std::getline(std::cin, line)) {
                JsonDoc doc(yyjson_read(line.data(), line.size(), 0), yyjson_doc_free);
                if (!doc) { throw std::runtime_error("invalid JSON input line"); }
                print_ids(tokenize(t, yyjson_doc_get_root(doc.get())));
            }
        } else if (have_text) {
            if (mode == "raw") { print_ids(heartmula_tokenizer_encode(t, text, add_bos)); }
            else if ((mode == "tags" || mode == "lyrics") && add_bos) {
                print_ids(heartmula_tokenizer_prompt(t, text, mode == "tags"));
            } else { throw std::runtime_error("invalid mode/special-token options"); }
        } else { throw std::runtime_error("provide --text, --stdin or --tokenizer-check"); }
        return 0;
    } catch (const std::exception & e) {
        std::cerr << "heartmula-probe: " << e.what() << '\n';
        return 1;
    }
}
