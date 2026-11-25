# engine-sim (github.com/ange-yaghi/engine-sim, MIT) for WebAssembly: the
# simulation core, its script compiler (piranha) and the constraint solver,
# with live.cpp as the entry point. Single-threaded, no Boost (patch-tree.py),
# no UI. Use build-wasm.sh, which generates the flex/bison sources on the
# host first:
#   emcmake cmake -S scripts/engine-sim/wasm -B <build> -DES_TREE=<tree-wasm> -DES_SHIM=<dir with FlexLexer.h> -DES_GEN=<dir with scanner/parser>
cmake_minimum_required(VERSION 3.16)
project(es_wasm CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_BUILD_TYPE Release)
if (NOT EMSCRIPTEN)
    message(FATAL_ERROR "configure with emcmake (build-wasm.sh)")
endif ()
if (NOT ES_TREE OR NOT EXISTS ${ES_TREE}/src)
    message(FATAL_ERROR "set -DES_TREE to the tree build-wasm.sh made")
endif ()
set(ES ${ES_TREE})
set(SUB ${ES}/dependencies/submodules)

# As the native build (scripts/engine-sim/CMakeLists.txt): MSVC keywords for
# clang, delayed template parsing, and FlexLexer.h matching the host flex.
add_compile_definitions("__forceinline=inline" "__int64=long long")
add_compile_options(-O3 -fdelayed-template-parsing -Wno-deprecated-declarations ${ES_CFLAGS})
include_directories(BEFORE ${CMAKE_CURRENT_SOURCE_DIR}/../shim ${ES_SHIM})

file(GLOB PIRANHA_SRC ${SUB}/piranha/src/*.cpp)
add_library(piranha STATIC ${PIRANHA_SRC} ${ES_GEN}/parser.auto.cpp ${ES_GEN}/scanner.auto.cpp)
target_include_directories(piranha PUBLIC ${ES_GEN} ${SUB}/piranha/include)

file(GLOB SCS_SRC ${SUB}/simple-2d-constraint-solver/src/*.cpp)
add_library(scs STATIC ${SCS_SRC})

add_library(csvio STATIC ${SUB}/csv-io/src/csv_data.cpp ${SUB}/csv-io/src/information.cpp)

set(CORE audio_buffer camshaft crankshaft combustion_chamber connecting_rod convolution_filter
    cylinder_bank cylinder_head delay_filter derivative_filter direct_throttle_linkage dynamometer
    engine exhaust_system feedback_comb_filter filter fuel function gas_system gaussian_filter
    governor ignition_module impulse_response intake jitter_filter leveling_filter low_pass_filter
    part piston piston_engine_simulator simulator standard_valvetrain starter_motor throttle
    transmission utilities valvetrain vehicle vehicle_drag_constraint vtec_valvetrain synthesizer)
list(TRANSFORM CORE PREPEND ${ES}/src/)
list(TRANSFORM CORE APPEND .cpp)
add_library(es_core STATIC ${CORE})
target_include_directories(es_core PUBLIC ${SUB})
target_link_libraries(es_core scs csvio)

file(GLOB SCRIPT_SRC ${ES}/scripting/src/*.cpp)
add_library(es_script STATIC ${SCRIPT_SRC})
target_include_directories(es_script PUBLIC ${SUB})
target_compile_definitions(es_script PUBLIC ATG_ENGINE_SIM_PIRANHA_ENABLED)
target_link_libraries(es_script es_core piranha csvio)

add_executable(engine-sim live.cpp)
target_include_directories(engine-sim PRIVATE ${ES})
target_compile_definitions(engine-sim PUBLIC ATG_ENGINE_SIM_PIRANHA_ENABLED)
target_link_libraries(engine-sim es_script es_core)
# An ES module factory (createEngineSim) for a module worker and for Node.
# The page fetches the .wasm itself and hands it over (wasmBinary), so it is
# instantiated with WebAssembly.instantiate and needs no application/wasm
# MIME type. The engine scripts are written into its in-memory filesystem.
set(EXPORTS _es_load,_es_script_frequency,_es_frequency,_es_rpm,_es_redline,_es_throttle,_es_held,_es_audio,_es_exhaust_count,_es_ir_volume,_es_starter,_es_ignition,_es_control,_es_run,_malloc,_free)
target_link_options(engine-sim PRIVATE ${ES_CFLAGS}
    -O3
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createEngineSim
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sSTACK_SIZE=4194304
    -sFORCE_FILESYSTEM=1
    -sEXPORTED_FUNCTIONS=${EXPORTS}
    -sEXPORTED_RUNTIME_METHODS=FS,HEAPF32,UTF8ToString,stringToNewUTF8
    -sINCOMING_MODULE_JS_API=wasmBinary,print,printErr,locateFile,instantiateWasm
    -sDYNAMIC_EXECUTION=0
    -sTEXTDECODER=2)
set_target_properties(engine-sim PROPERTIES SUFFIX .js)  # .js: the Pi serves only .js as JavaScript
